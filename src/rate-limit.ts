import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitState, ZoneState } from "./types.js";

// Rate-limit state has to live on disk, not in memory.
//
// mcpjungle runs this server over stdio and spawns a fresh `node dist/index.js`
// for every single tool call. A module-level counter is therefore born empty and
// dies moments later, which is why get_rate_limit_status reported
// `last_updated: "never"` no matter how many requests had just been made -- the
// process answering the question had never made one.
//
// This directory is the same one auth.ts keeps tokens.json in, and it is the only
// writable path the container has (the code mount is :ro).
const CONFIG_DIR = process.env.INOREADER_CONFIG_DIR ?? join(homedir(), ".config", "inoreader-mcp");
const STATE_PATH = join(CONFIG_DIR, "rate-limit.json");

function emptyZone(): ZoneState {
  return { limit: null, usage: null, resetAfterSec: null, lastUpdated: 0, attemptCount: 0, usageAttemptCount: 0 };
}

function emptyState(): RateLimitState {
  return {
    zone1: emptyZone(),
    zone2: emptyZone(),
    local: { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 },
    unknownHeaders: {},
  };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

let cached: RateLimitState | null = null;

/** Legacy/corrupt telemetry must not create fake headroom or break status reads. */
function normalizeZone(raw: ZoneState): ZoneState {
  const zone = emptyZone();
  const fields = ["limit", "usage", "resetAfterSec", "lastUpdated", "limitObservedAt", "usageObservedAt", "usageExpiresAt", "resetObservedAt", "attemptCount", "usageAttemptCount", "cooldownUntil", "conservativeUsage"] as const;
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000) {
      if (field === "resetAfterSec" && value > (8_639_999_999_999_999 - Date.now()) / 1000) continue;
      zone[field] = value;
    }
  }
  // Old files only had lastUpdated, which could have been stamped by unrelated
  // headers. Retain the observation for display but do not trust it for admission.
  return zone;
}

function load(): RateLimitState {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as RateLimitState;
    if (parsed?.zone1 && typeof parsed.zone1 === "object" && parsed?.zone2 && typeof parsed.zone2 === "object") {
      parsed.zone1 = normalizeZone(parsed.zone1);
      parsed.zone2 = normalizeZone(parsed.zone2);
      if (!parsed.local || !Number.isSafeInteger(parsed.local.zone1Count) || parsed.local.zone1Count < 0 || !Number.isSafeInteger(parsed.local.zone2Count) || parsed.local.zone2Count < 0) {
        parsed.local = { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
      }
      parsed.unknownHeaders = Object.fromEntries(Object.entries(parsed.unknownHeaders ?? {}).filter(([, v]) => typeof v === "string"));
      // A new day resets the local attempt display. The header-derived numbers are
      // left alone; Inoreader will correct them on the next response.
      if (parsed.local.dayKey !== todayKey()) {
        parsed.local = { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
      }
      cached = parsed;
      return cached;
    }
  } catch {
    // absent, unreadable or corrupt -- start clean rather than fail a tool call
  }
  cached = emptyState();
  return cached;
}

function persist(state: RateLimitState): void {
  // Telemetry must never be able to break an API call, so every failure here is
  // swallowed. The temp name carries pid + uuid because oauth-callback/app.py
  // writes this same directory using a FIXED `.tmp` suffix; a shared name would
  // let the two clobber each other mid-write.
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // 0644, not 0600: these are request counters, not secrets, and under the
      // container deployment this file is written as root while the host user may
      // want to read it. tokens.json stays 0600 -- that one is a credential.
      writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o644 });
      renameSync(tmp, STATE_PATH);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      throw e;
    }
  } catch {
    /* ignore */
  }
}

/**
 * Record whatever Inoreader told us about our budget.
 *
 * Inoreader sends X-Reader-Zone{1,2}-Limit / -Usage and X-Reader-Limits-Reset-After.
 * This used to read `x-reader-limits-zone1`, which matches nothing, so `limit` could
 * never leave 0 and every report rendered "unknown". Both spellings are accepted now
 * -- reading two names costs nothing and means a rename cannot silently blind us
 * again. Anything else beginning with `x-reader-` is stashed verbatim so a header we
 * do not know about yet shows up in get_rate_limit_status instead of vanishing.
 */
export interface ParsedRateHeaders {
  zone1: { limit: number | null; usage: number | null };
  zone2: { limit: number | null; usage: number | null };
  resetAfterSec: number | null;
  /** x-reader-* headers we do not consume, so a rename is visible rather than silent. */
  unknown: Record<string, string>;
  /** True when at least one recognised value was present. */
  saw: boolean;
}

/**
 * Pure header parse, split out so it can be tested without touching disk.
 *
 * Reads both spellings per field. The old code read only `x-reader-limits-zone1`,
 * which matches nothing Inoreader sends, so `limit` never left 0 -- and because the
 * formatter rendered `limit || "unknown"`, the parse failure looked like a display
 * quirk for months. Reading two names costs nothing and makes that unrepeatable.
 */
export function parseRateHeaders(headers: Headers): ParsedRateHeaders {
  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const v = headers.get(n);
      if (v !== null && v !== "") return v;
    }
    return null;
  };

  const num = (raw: string | null): number | null => {
    if (raw === null) return null;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };

  const out: ParsedRateHeaders = {
    zone1: {
      limit: num(pick("x-reader-zone1-limit", "x-reader-limits-zone1")),
      usage: num(pick("x-reader-zone1-usage", "x-reader-usage-zone1")),
    },
    zone2: {
      limit: num(pick("x-reader-zone2-limit", "x-reader-limits-zone2")),
      usage: num(pick("x-reader-zone2-usage", "x-reader-usage-zone2")),
    },
    resetAfterSec: num(pick("x-reader-limits-reset-after", "x-reader-zone1-reset-after")),
    unknown: {},
    saw: false,
  };

  if (out.resetAfterSec !== null && out.resetAfterSec > (8_639_999_999_999_999 - Date.now()) / 1000) out.resetAfterSec = null;
  out.saw =
    out.zone1.limit !== null ||
    out.zone1.usage !== null ||
    out.zone2.limit !== null ||
    out.zone2.usage !== null ||
    out.resetAfterSec !== null;

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("x-reader-")) continue;
    if (/^x-reader-(zone[12]-(limit|usage)|limits-zone[12]|usage-zone[12]|limits-reset-after|zone1-reset-after)$/.test(lower)) continue;
    out.unknown[lower] = value;
  }

  return out;
}

export type AttemptCounts = { zone1: number; zone2: number };

export function updateFromHeaders(headers: Headers, atDispatch?: AttemptCounts): void {
  const parsed = parseRateHeaders(headers);
  const state = load();

  const now = Date.now();
  const apply = (zone: ZoneState, values: ParsedRateHeaders["zone1"], dispatched: number | undefined) => {
    if (values.limit !== null) {
      zone.limit = values.limit;
      zone.limitObservedAt = now;
    }
    if (values.usage !== null) {
      // Concurrent responses can arrive out of order. Never lower usage inside
      // the observed window; after reset a lower count is legitimate.
      const expired = observationExpired(zone, now);
      const prior = expired ? 0 : zone.conservativeUsage ?? zone.usage ?? 0;
      zone.usage = values.usage; // actual latest received header, never label an estimate authoritative
      zone.conservativeUsage = Math.max(prior, values.usage);
      zone.usageObservedAt = now;
      zone.usageExpiresAt = parsed.resetAfterSec !== null
        ? now + parsed.resetAfterSec * 1000
        : zone.resetObservedAt !== undefined && zone.resetAfterSec !== null && zone.resetObservedAt + zone.resetAfterSec * 1000 > now
          ? zone.resetObservedAt + zone.resetAfterSec * 1000 : now + 24 * 60 * 60 * 1000;
      zone.usageAttemptCount = dispatched ?? zone.attemptCount ?? 0;
    }
    if (values.limit !== null || values.usage !== null) zone.lastUpdated = now;
    if (parsed.resetAfterSec !== null) {
      zone.resetAfterSec = parsed.resetAfterSec;
      zone.resetObservedAt = now;
    }
  };
  apply(state.zone1, parsed.zone1, atDispatch?.zone1);
  apply(state.zone2, parsed.zone2, atDispatch?.zone2);
  Object.assign(state.unknownHeaders, parsed.unknown);
  if (parsed.saw || Object.keys(parsed.unknown).length) persist(state);
}

/**
 * Count a request we are about to make.
 *
 * This is an attempt count, deliberately independent of response headers: it
 * keeps working if Inoreader renames a header again, and it is the only budget
 * signal available before the first response of the day comes back.
 */
export function noteRequest(zone: 1 | 2): AttemptCounts {
  assertBudget(zone, 1, "HTTP attempt");
  const state = load();
  if (state.local.dayKey !== todayKey()) {
    state.local = { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
  }
  if (zone === 1) state.local.zone1Count++;
  else state.local.zone2Count++;
  const z = zone === 1 ? state.zone1 : state.zone2;
  z.attemptCount = (z.attemptCount ?? 0) + 1;
  persist(state);
  return { zone1: state.zone1.attemptCount ?? 0, zone2: state.zone2.attemptCount ?? 0 };
}

export function getState(): RateLimitState {
  const state = load();
  if (state.local.dayKey !== todayKey()) {
    state.local = { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
  }
  return structuredClone(state);
}

function limitExpired(zone: ZoneState, now = Date.now()): boolean {
  return zone.limitObservedAt === undefined || now - zone.limitObservedAt >= 24 * 60 * 60 * 1000;
}

function observationExpired(zone: ZoneState, now = Date.now()): boolean {
  if (!zone.usageObservedAt) return true; // legacy files lack field-level provenance
  return now >= (zone.usageExpiresAt ?? zone.usageObservedAt + 24 * 60 * 60 * 1000);
}

export class BudgetError extends Error {}

/** Preflight is conservative, not a quota reservation; every attempt rechecks. */
export function assertBudget(zone: 1 | 2, requests: number, workflow: string, reserve = 0): void {
  const z = zone === 1 ? load().zone1 : load().zone2;
  if ((z.cooldownUntil ?? 0) > Date.now()) {
    throw new BudgetError(`Zone ${zone} cooldown until ${new Date(z.cooldownUntil!).toISOString()}; ${workflow} not started.`);
  }
  const { remaining, source } = zoneRemaining(zone);
  if (remaining !== null && remaining < requests + reserve) {
    throw new BudgetError(`Insufficient Zone ${zone} budget for ${workflow}: need ${requests} + ${reserve} reserve, ${remaining} remaining (${source}). No automatic write replay.`);
  }
}

export function setCooldown(zone: 1 | 2, delayMs: number): void {
  const state = load();
  const z = zone === 1 ? state.zone1 : state.zone2;
  z.cooldownUntil = Math.max(z.cooldownUntil ?? 0, Math.min(8_639_999_999_999_999, Date.now() + delayMs));
  persist(state);
}

/**
 * Best available view of what is left in a zone, and how we know.
 *
 * `source` distinguishes the received header from conservative admission estimates
 * (later attempts and out-of-order responses). Other clients are unseen; expired
 * observations are unknown. UTC local counts alone cannot establish an upstream
 * reset window or quota allowance.
 */
export function zoneRemaining(zone: 1 | 2): {
  remaining: number | null;
  source: "headers" | "headers+local-estimate" | "unknown";
} {
  const state = load();
  const z = zone === 1 ? state.zone1 : state.zone2;
  if (z.limit !== null && z.usage !== null && !limitExpired(z) && !observationExpired(z)) {
    const since = Math.max(0, (z.attemptCount ?? 0) - (z.usageAttemptCount ?? 0));
    return {
      remaining: Math.max(0, z.limit - (z.conservativeUsage ?? z.usage) - since),
      source: since || (z.conservativeUsage ?? z.usage) !== z.usage ? "headers+local-estimate" : "headers",
    };
  }
  return { remaining: null, source: "unknown" };
}

/** Shared renderer for get_rate_limit_status and the inoreader://rate-limits resource. */
export function formatZone(zone: ZoneState, name: string) {
  const now = Date.now();
  const resetAt = zone.resetObservedAt !== undefined && zone.resetAfterSec !== null
    ? zone.resetObservedAt + zone.resetAfterSec * 1000 : null;
  const expired = observationExpired(zone, now);
  const remaining = !expired && !limitExpired(zone, now) && zone.limit !== null && zone.usage !== null ? Math.max(0, zone.limit - zone.usage) : "unknown";
  return {
    zone: name,
    used: zone.usage ?? "unknown",
    conservative_usage_for_admission: zone.conservativeUsage ?? zone.usage ?? "unknown",
    limit: zone.limit ?? "unknown",
    remaining,
    reset_in_minutes: resetAt !== null ? Math.max(0, Math.ceil((resetAt - now) / 60_000)) : "unknown",
    reset_at: resetAt !== null ? new Date(resetAt).toISOString() : null,
    reset_observed_at: zone.resetObservedAt ? new Date(zone.resetObservedAt).toISOString() : null,
    usage_observed_at: zone.usageObservedAt ? new Date(zone.usageObservedAt).toISOString() : null,
    limit_observed_at: zone.limitObservedAt ? new Date(zone.limitObservedAt).toISOString() : null,
    observation_expired: expired,
    limit_observation_expired: limitExpired(zone, now),
    local_attempts_since_usage: Math.max(0, (zone.attemptCount ?? 0) - (zone.usageAttemptCount ?? 0)),
    cooldown_until: (zone.cooldownUntil ?? 0) > now ? new Date(zone.cooldownUntil!).toISOString() : null,
    last_updated: zone.lastUpdated ? new Date(zone.lastUpdated).toISOString() : "never",
  };
}

/** Full snapshot for reporting, including the local attempt counter. */
export function snapshot() {
  const state = getState();
  return {
    snapshot_at: new Date().toISOString(),
    zone1_reads: { ...formatZone(state.zone1, "reads"), admission: zoneRemaining(1) },
    zone2_writes: { ...formatZone(state.zone2, "writes"), admission: zoneRemaining(2) },
    policy: "Zero upstream requests. Headers are authoritative only at observation time; later local attempts are conservative estimates. Other clients and processes can consume quota unseen. Expired/missing usage or limit provenance means unknown, not free calls. Limits and usage without a reset header are treated as stale after 24h (local freshness policy, not an inferred upstream reset). Admission and concurrency are per process; persisted snapshots are best-effort, not a cross-process lock.",
    counted_locally_today: {
      day: state.local.dayKey,
      zone1: state.local.zone1Count,
      zone2: state.local.zone2Count,
      note: "Every attempted API fetch including retries and transport failures, UTC day. Not necessarily charged by the server and not a quota total; OAuth and public-site requests are not Zone 1/2 API calls.",
    },
    ...(Object.keys(state.unknownHeaders).length > 0
      ? { unrecognized_x_reader_headers: state.unknownHeaders }
      : {}),
  };
}
