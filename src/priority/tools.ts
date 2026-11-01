import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiPost } from "../api.js";
import { assertBudget, zoneRemaining } from "../rate-limit.js";
import { diffIntents, SETTLE_MS, sleep } from "../verify.js";
import { jsonResult } from "../contracts.js";
import { configHash, loadPriorityConfig, priorityProfile, type PriorityProfile } from "./config.js";
import { DAY, isMember, nextCursor, readFreshMembership, refreshEvidence, weekKey } from "./evidence.js";
import { calibrationReport, policyReport } from "./policy.js";
import { listSnapshots, readDecisions, readSnapshot, saveDecisions, withProfileLock, SNAPSHOT_WORKING_WEEKS, type Decisions } from "./store.js";

export async function getPriorityStatus(p: PriorityProfile, args: { snapshot_id?: string; offset?: number; limit?: number }) {
  const offset = args.offset ?? 0, limit = args.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid pagination: offset>=0; limit 1-500");
  const d = await readDecisions(p.name);
  const id = args.snapshot_id ?? d.active_snapshot ?? d.latest_snapshot;
  const all = await listSnapshots(p.name, { include_ids: [...new Set([id, d.active_snapshot, d.latest_snapshot].filter((value): value is string => value !== null))] });
  const s = id ? await readSnapshot(p.name, id) : null;
  const report = s ? policyReport(p, s, d, all) : null;
  const calibration = calibrationReport(p, all, d);
  const rows = report?.rows ?? [];
  const quantiles = (values: number[]) => { values.sort((a, b) => a - b); return Object.fromEntries([0.1, 0.5, 0.9, 0.95].map(q => [String(q), values.length ? values[Math.floor((values.length - 1) * q)] : null])); };
  return { profile: p.name, config_hash: configHash(p), policy: p, calibration,
    collection: s ? { snapshot_id: s.id, complete: s.phase === "complete" && !!s.completed_at, config_hash: s.config_hash, config_matches: s.config_hash === configHash(p), model: s.model, started_at: s.started_at, completed_at: s.completed_at, stale: !s.completed_at || Date.now() - s.started_at > 7 * DAY, phase: s.phase, next_cursor: nextCursor(s), source_coverage: s.source_coverage, base_reads: s.base_reads, errors: s.errors, historical_window_start: s.cutoff } : null,
    membership: d.membership, decisions: d.preferences, write_intents: d.intents, migrations: d.migrations,
    summary: { total_feeds: rows.length, volume_feeds_complete: s ? Object.values(s.volumes).filter(v => v.complete).length : 0, prospective_mature_articles: rows.reduce((n, r) => n + r.prospective.n, 0), historical_articles: rows.reduce((n, r) => n + r.historical.n, 0), prospective_priors: report?.prospective_priors ?? null, historical_priors: report?.historical_priors ?? null, rate_quantiles: quantiles(rows.flatMap(r => r.prospective.posterior ? [r.prospective.posterior.mean] : [])), candidate_count: rows.filter(r => r.auto_add_candidate).length, expected_posts_per_month: rows.filter(r => r.current_member).reduce((n, r) => n + r.historical.n / p.window_months, 0), weekly_additions_reserved: report?.weekly_additions_reserved ?? 0, weekly_slots: report?.weekly_slots ?? 5, cutoff_sweep: report?.cutoff_sweep ?? [] },
    feeds: rows.slice(offset, offset + limit), offset, next_offset: offset + limit < rows.length ? offset + limit : null, total: rows.length,
    api_cost_z1: 0, api_cost_z2: 0, limitations: ["Historical retained-item rates do not authorize automatic promotion.", "A manual remove and re-add between membership observations cannot be reconstructed.", "Single HTTP writer process only; no distributed locking.", `Policy/calibration working set: newest ${SNAPSHOT_WORKING_WEEKS} complete distinct weekly snapshots plus active/latest/requested snapshots. Older archives remain readable explicitly; none are deleted.`,  "Missing/incomplete observations never authorize removal; removal_suggestion is advisory only."] };
}
const actions = ["auto_add", "pin", "exclude", "allow", "remove"] as const;
type ManageArgs = { stream_id: string; action: typeof actions[number]; snapshot_id?: string; reason: string };
function recordPreference(p: PriorityProfile, d: Decisions, args: ManageArgs) {
  const pref = d.preferences[args.stream_id] ?? { pin: false, exclude: false, history: [] };
  if (args.action === "exclude" || args.action === "remove") { pref.exclude = true; pref.pin = false; }
  if (args.action === "allow") { pref.exclude = false; pref.pin = false; }
  if (args.action === "pin") { if (pref.exclude) throw new Error("Feed excluded; explicitly allow it before pinning"); pref.pin = true; }
  pref.history.push({ action: args.action, reason: args.reason, at: Date.now(), config_hash: configHash(p), ...(args.snapshot_id ? { snapshot_id: args.snapshot_id } : {}) });
  d.preferences[args.stream_id] = pref;
}
export async function managePriority(p: PriorityProfile, args: ManageArgs) {
  if (!args.reason.trim() || !args.stream_id.startsWith("feed/")) throw new Error("A feed stream_id and nonempty reason are required");
  const d = await readDecisions(p.name);
  // A durable exclusion precedes even quota admission or membership reads.
  if (args.action === "exclude" || args.action === "remove") { recordPreference(p, d, args); await saveDecisions(p.name, d); }
  if (args.action === "exclude") return { profile: p.name, stream_id: args.stream_id, action: args.action, status: "recorded", applied: true, membership_changed: false, decision: d.preferences[args.stream_id] };
  if (d.migrations.some(m => m.status === "pending" && (m.old_id === args.stream_id || m.new_id === args.stream_id))) throw new Error("Pending identity migration blocks changes; resume verified replacement migration");
  const pending = d.intents.find(i => i.stream_id === args.stream_id && (i.status === "pending" || i.status === "unverified"));
  if (pending) {
    const subs = await readFreshMembership(p, d), sub = subs.find(s => s.id === args.stream_id);
    const topicsPreserved = pending.original_topic_ids.every(id => sub?.categories.some(c => c.id === id));
    const satisfied = !!sub && topicsPreserved && (pending.action === "remove" ? !isMember(sub, p) : isMember(sub, p));
    pending.status = satisfied ? "verified" : sub && topicsPreserved ? "not_applied" : "unverified";
    await saveDecisions(p.name, d);
    return { profile: p.name, stream_id: args.stream_id, action: pending.action, status: pending.status, applied: satisfied, reconciliation_only: true, intent_id: pending.id, warning: "Previous write reconciled read-only, never replayed in this call. A complete opposite result is terminal not_applied; a later explicit call may retry. Missing/ambiguous state remains unresolved and blocks writes." };
  }
  if (args.action === "allow") {
    recordPreference(p, d, args); await saveDecisions(p.name, d);
    return { profile: p.name, stream_id: args.stream_id, action: args.action, status: "recorded", applied: true, membership_changed: false, decision: d.preferences[args.stream_id] };
  }
  const quotaKnownAtEntry = zoneRemaining(1).remaining !== null && zoneRemaining(2).remaining !== null;
  const subs = await readFreshMembership(p, d), sub = subs.find(s => s.id === args.stream_id);
  if (!sub) throw new Error("Feed is not subscribed; priority never subscribes/unsubscribes feeds");
  const member = isMember(sub, p);
  if (args.action === "pin") { recordPreference(p, d, args); await saveDecisions(p.name, d); }
  if (args.action === "auto_add") {
    if (!p.auto_add_enabled || p.promotion_probability === null || !p.calibration || p.calibration.config_hash !== configHash(p) || p.calibration.promotion_probability !== p.promotion_probability) throw new Error("Automatic additions disabled or not reviewed for this config hash");
    if (!quotaKnownAtEntry || zoneRemaining(1).remaining === null || zoneRemaining(2).remaining === null) throw new Error("Unknown quota: collection observation only, no automatic additions");
    const id = args.snapshot_id ?? d.latest_snapshot;
    if (!id || id !== d.latest_snapshot) throw new Error("Auto-add requires latest complete snapshot");
    const s = await readSnapshot(p.name, id), all = await listSnapshots(p.name, { include_ids: [id] });
    if (s.phase !== "complete" || !s.completed_at || Date.now() - s.started_at > 7 * DAY || s.config_hash !== configHash(p)) throw new Error("Auto-add requires fresh complete matching-config evidence");
    if (!calibrationReport(p, all, d).ready_for_review) throw new Error("Insufficient held-out calibration evidence");
    const report = policyReport(p, s, d, all);
    if (!member && !report.ranked_ids.includes(args.stream_id)) throw new Error("Feed not eligible in two successive weekly snapshots or weekly five-addition limit/rank blocks it");
    if (d.preferences[args.stream_id]?.exclude) throw new Error("Feed excluded");
  }
  if (args.action === "remove" ? !member : member) return { profile: p.name, stream_id: args.stream_id, action: args.action, status: "verified", applied: true, membership_changed: false, already_satisfied: true };
  assertBudget(1, 4, "priority verified write", 25); assertBudget(2, args.action === "remove" ? 1 : 2, "priority verified write");
  const now = Date.now();
  const intent = { id: `${now}-${d.intents.length}`, reason: args.reason, config_hash: configHash(p), original_topic_ids: sub.categories.filter(c => c.label.trim().toLowerCase() !== p.folder.trim().toLowerCase()).map(c => c.id), stream_id: args.stream_id, action: args.action, at: now, week: weekKey(now), snapshot_id: args.snapshot_id ?? d.latest_snapshot ?? undefined, status: "pending" as "pending" | "verified" | "unverified" | "not_applied", error: undefined as string | undefined };
  d.intents.push(intent); await saveDecisions(p.name, d);
  try {
    if (args.action === "remove") {
      await apiPost<string>("/reader/api/0/subscription/edit", { ac: "edit", s: args.stream_id, r: `user/-/label/${p.folder}` }, undefined, { expectOk: true });
      await sleep(SETTLE_MS);
    } else {
      await apiPost<string>("/reader/api/0/subscription/edit", { ac: "edit", s: args.stream_id, a: `user/-/label/${p.folder}` }, undefined, { expectOk: true });
      await sleep(SETTLE_MS);
    }
  } catch (error) { intent.error = String(error); }
  // Even an ambiguous POST is followed by observation, NEVER a blind replay.
  try {
    const actual = (await readFreshMembership(p, d)).find(s => s.id === args.stream_id);
    const topicsPreserved = sub.categories.filter(c => c.label.trim().toLowerCase() !== p.folder.trim().toLowerCase()).every(c => actual?.categories.some(a => a.id === c.id));
    const additionSatisfied = actual ? diffIntents([{ streamId: args.stream_id, folder: p.folder }], new Map([[actual.id, new Set(actual.categories.map(c => c.label.trim().toLowerCase()))]])).shortfall.length === 0 : false;
    const satisfied = !!actual && topicsPreserved && (args.action === "remove" ? !isMember(actual, p) : additionSatisfied);
    intent.status = satisfied ? "verified" : actual && topicsPreserved ? "not_applied" : "unverified";
    if (!topicsPreserved) intent.error = "Original topic memberships not preserved in read-back";
  } catch (error) { intent.status = "unverified"; intent.error = String(error); }
  await saveDecisions(p.name, d);
  return { profile: p.name, stream_id: args.stream_id, action: args.action, status: intent.status, applied: intent.status === "verified", membership_changed: intent.status === "verified", intent_id: intent.id, ...(intent.error ? { error: intent.error } : {}), decision: d.preferences[args.stream_id] ?? null };
}

/** Called only after replacement identity/folders are verified, before old feed
 * unsubscribe. Failures propagate so callers retain the old subscribed identity. */
export async function migratePriorityFeed(oldId: string, newId: string): Promise<void> {
  const profiles = loadPriorityConfig();
  if (!profiles.length || oldId === newId) return;
  if (!oldId.startsWith("feed/") || !newId.startsWith("feed/")) throw new Error("Priority migration expects feed stream IDs");
  for (const p of profiles) await withProfileLock(p.name, async () => {
    const d = await readDecisions(p.name);
    let migration = d.migrations.find(m => m.old_id === oldId && m.new_id === newId);
    if (migration?.status === "complete") return;
    if (!migration) { migration = { old_id: oldId, new_id: newId, at: Date.now(), status: "pending" }; d.migrations.push(migration); await saveDecisions(p.name, d); }
    const old = d.preferences[oldId], current = d.preferences[newId];
    if (old || current) {
      const excluded = !!(old?.exclude || current?.exclude);
      d.preferences[newId] = { exclude: excluded, pin: !excluded && !!(old?.pin || current?.pin), history: [...(current?.history ?? []), ...(old?.history ?? []), { action: "replacement_migration", reason: `Verified replacement of ${oldId}; exclusion takes precedence`, at: Date.now(), config_hash: configHash(p) }] };
    }
    // Never transfer article evidence to a different source identity.
    d.observations[newId] ??= { first_observed: Date.now(), last_complete: null, gap_blocked: false, articles: [] };
    if (d.membership?.ids.includes(oldId) && !d.membership.ids.includes(newId)) {
      d.membership.ids.push(newId); d.membership.since[newId] = d.membership.since[oldId] ?? Date.now();
    }
    migration.status = "complete"; await saveDecisions(p.name, d);
  });
}
export function registerPriorityTools(server: McpServer): void {
  if (!loadPriorityConfig().length) return;
  const profile = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  server.registerTool("refresh_feed_priority", { title: "Refresh feed priority evidence", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "Explicitly start or resume named durable shadow evidence. No upstream writes. Default 25/max 50 base Zone 1 reads per call; safe read retries (up to 4 attempts) cost extra, preserve 25-read reserve and honor cooldown. Resume committed cursor after errors. This mutates local evidence, not folders.", inputSchema: z.object({ profile, start_new: z.boolean().optional(), snapshot_id: z.string().optional(), max_requests: z.number().int().min(1).max(50).optional() }) }, async ({ profile: name, ...args }) => withProfileLock(name, async () => jsonResult(await refreshEvidence(priorityProfile(name), args))));
  server.registerTool("get_feed_priority", { title: "Get feed priority evidence", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Zero upstream/auth requests. Paginated existing snapshot, explicit completeness/staleness, historical versus mature prospective posteriors, durable preferences, shadow cutoff sweep and held-out calibration readiness. Partial data is never complete. Removal suggestions are advisory, never an authorization.", inputSchema: z.object({ profile, snapshot_id: z.string().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }) }, async ({ profile: name, ...args }) => withProfileLock(name, async () => jsonResult(await getPriorityStatus(priorityProfile(name), args))));
  server.registerTool("manage_feed_priority", { title: "Manage feed priority preference", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, description: "Pin/remove REQUIRE an explicit user request: a tool argument, model score, suggestion or silence is not proof of authorization. Pin ensures membership; exclusion blocks additions without removal; allow clears pin/exclusion without adding; remove durably excludes FIRST then removes ONLY the priority folder, never unsubscribes. Auto-add alone uses enabled reviewed calibrated policy, two weekly complete forward snapshots and max five additions/week. Exclude/allow cost zero upstream reads absent unresolved intents; verified changes cost membership/verification reads and 1-2 Zone 2 edits; read retries extra, 25-read reserve. Uncertain writes are reconciled read-only, never blindly replayed.", inputSchema: z.object({ profile, stream_id: z.string().startsWith("feed/").max(8192), action: z.enum(actions), snapshot_id: z.string().optional(), reason: z.string().trim().min(1).max(8192) }) }, async ({ profile: name, ...args }) => withProfileLock(name, async () => { const result = await managePriority(priorityProfile(name), args); return { ...jsonResult(result), ...(result.applied ? {} : { isError: true }) }; }));
}
