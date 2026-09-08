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
const CONFIG_DIR = join(homedir(), ".config", "inoreader-mcp");
const STATE_PATH = join(CONFIG_DIR, "rate-limit.json");

function emptyZone(): ZoneState {
  return { limit: null, usage: null, resetAfterSec: null, lastUpdated: 0 };
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

function load(): RateLimitState {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as RateLimitState;
    if (parsed?.zone1 && parsed?.zone2) {
      parsed.local ??= { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
      parsed.unknownHeaders ??= {};
      // A new day resets the locally counted floor. The header-derived numbers are
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
export function updateFromHeaders(headers: Headers): void {
  const state = load();

  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const v = headers.get(n);
      if (v !== null && v !== "") return v;
    }
    return null;
  };

  const z1Limit = pick("x-reader-zone1-limit", "x-reader-limits-zone1");
  const z1Usage = pick("x-reader-zone1-usage", "x-reader-usage-zone1");
  const z2Limit = pick("x-reader-zone2-limit", "x-reader-limits-zone2");
  const z2Usage = pick("x-reader-zone2-usage", "x-reader-usage-zone2");
  const resetAfter = pick("x-reader-limits-reset-after", "x-reader-zone1-reset-after");

  const num = (raw: string | null): number | null => {
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  let saw = false;
  const apply = (zone: ZoneState, limit: number | null, usage: number | null) => {
    if (limit !== null) {
      zone.limit = limit;
      saw = true;
    }
    if (usage !== null) {
      zone.usage = usage;
      saw = true;
    }
  };

  apply(state.zone1, num(z1Limit), num(z1Usage));
  apply(state.zone2, num(z2Limit), num(z2Usage));

  const reset = num(resetAfter);
  if (reset !== null) {
    state.zone1.resetAfterSec = reset;
    state.zone2.resetAfterSec = reset;
    saw = true;
  }

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("x-reader-")) continue;
    if (
      lower.includes("zone1") ||
      lower.includes("zone2") ||
      lower === "x-reader-limits-reset-after"
    ) {
      continue;
    }
    state.unknownHeaders[lower] = value;
  }

  // Only claim freshness when a header actually arrived. The old code stamped
  // lastUpdated unconditionally, so the numbers looked current even when nothing
  // had refreshed them.
  if (!saw) return;
  const now = Date.now();
  state.zone1.lastUpdated = now;
  state.zone2.lastUpdated = now;
  persist(state);
}

/**
 * Count a request we are about to make.
 *
 * This is a floor estimate, deliberately independent of the response headers: it
 * keeps working if Inoreader renames a header again, and it is the only budget
 * signal available before the first response of the day comes back.
 */
export function noteRequest(zone: 1 | 2): void {
  const state = load();
  if (state.local.dayKey !== todayKey()) {
    state.local = { dayKey: todayKey(), zone1Count: 0, zone2Count: 0 };
  }
  if (zone === 1) state.local.zone1Count++;
  else state.local.zone2Count++;
  persist(state);
}

export function getState(): RateLimitState {
  return structuredClone(load());
}

/**
 * Best available view of what is left in a zone, and how we know.
 *
 * `source` matters to callers: "headers" is authoritative, "local-count" is a floor
 * derived from requests this client made today (it cannot see usage from other
 * clients), and "unknown" means refuse to guess.
 */
export function zoneRemaining(zone: 1 | 2): {
  remaining: number | null;
  source: "headers" | "local-count" | "unknown";
} {
  const state = load();
  const z = zone === 1 ? state.zone1 : state.zone2;
  if (z.limit !== null && z.usage !== null) {
    return { remaining: Math.max(0, z.limit - z.usage), source: "headers" };
  }
  const used = zone === 1 ? state.local.zone1Count : state.local.zone2Count;
  if (z.limit !== null) {
    return { remaining: Math.max(0, z.limit - used), source: "local-count" };
  }
  return { remaining: null, source: "unknown" };
}

/** Shared renderer for get_rate_limit_status and the inoreader://rate-limits resource. */
export function formatZone(zone: ZoneState, name: string) {
  const remaining = zone.limit !== null && zone.usage !== null ? zone.limit - zone.usage : "unknown";
  return {
    zone: name,
    used: zone.usage ?? "unknown",
    limit: zone.limit ?? "unknown",
    remaining,
    reset_in_minutes: zone.resetAfterSec !== null ? Math.ceil(zone.resetAfterSec / 60) : "unknown",
    last_updated: zone.lastUpdated ? new Date(zone.lastUpdated).toISOString() : "never",
  };
}

/** Full snapshot for reporting, including the local floor counter. */
export function snapshot() {
  const state = getState();
  return {
    zone1_reads: formatZone(state.zone1, "reads"),
    zone2_writes: formatZone(state.zone2, "writes"),
    counted_locally_today: {
      day: state.local.dayKey,
      zone1: state.local.zone1Count,
      zone2: state.local.zone2Count,
      note: "Requests this client made today. A floor, not the server's count.",
    },
    ...(Object.keys(state.unknownHeaders).length > 0
      ? { unrecognized_x_reader_headers: state.unknownHeaders }
      : {}),
  };
}
