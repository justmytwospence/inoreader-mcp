import { randomUUID } from "node:crypto";
import { apiGet } from "../api.js";
import { assertBudget } from "../rate-limit.js";
import { labelType } from "../labels.js";
import { normalizeItemId } from "../verify-tags.js";
import type { InoreaderSubscription, StreamContentsResponse, StreamItemIdsResponse, SubscriptionListResponse, TagListResponse, UnreadCountResponse } from "../types.js";
import { configHash, type PriorityProfile } from "./config.js";
import { readDecisions, readSnapshot, saveDecisions, saveSnapshot, SnapshotSchema, type Decisions, type PrioritySnapshot } from "./store.js";

export const DAY = 86400000;
export const weekKey = (at: number): string => {
  const d = new Date(at); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
};
const canonicalStream = (s: string) => s.replace(/^user\/[^/]+\//, "user/-/");
export const isMember = (s: InoreaderSubscription, p: PriorityProfile): boolean => s.categories.some(c => c.label.trim().toLowerCase() === p.folder.trim().toLowerCase());
export function validateMembership(data: SubscriptionListResponse): InoreaderSubscription[] {
  if (!Array.isArray(data.subscriptions) || "continuation" in data || data.subscriptions.some(s => !s.id || !Array.isArray(s.categories) || s.categories.some(c => typeof c.label !== "string"))) throw new Error("Incomplete or invalid subscription membership response");
  if (new Set(data.subscriptions.map(s => s.id)).size !== data.subscriptions.length) throw new Error("Duplicate subscriptions in membership response");
  return data.subscriptions;
}
/** Only complete fresh subscription/list responses may establish a manual veto. */
export function observeMembership(p: PriorityProfile, d: Decisions, subscriptions: InoreaderSubscription[], at: number): string[] {
  const ids = subscriptions.filter(s => isMember(s, p)).map(s => s.id);
  const present = new Set(ids), subscribed = new Set(subscriptions.map(s => s.id));
  for (const old of d.membership?.ids ?? []) {
    if (!present.has(old) && subscribed.has(old)) {
      const pref = d.preferences[old] ?? { pin: false, exclude: false, history: [] };
      pref.exclude = true; pref.pin = false;
      pref.history.push({ action: "manual_removal", reason: "Absent from complete fresh folder membership", at, config_hash: configHash(p) });
      d.preferences[old] = pref;
    }
  }
  const since = Object.fromEntries(ids.map(id => [id, d.membership?.since[id] ?? at]));
  d.membership = { at, ids, since };
  for (const s of subscriptions) d.observations[s.id] ??= { first_observed: at, last_complete: null, gap_blocked: false, articles: [] };
  return ids;
}
export async function readFreshMembership(p: PriorityProfile, d: Decisions): Promise<InoreaderSubscription[]> {
  assertBudget(1, 1, "priority membership", 25);
  const subs = validateMembership(await apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", { output: "json" }, { reserve: 25 }));
  observeMembership(p, d, subs, Date.now());
  await saveDecisions(p.name, d);
  return subs;
}
function mergeArticles(a: { id: string; timestamp: number }[], b: { id: string; timestamp: number }[]): { id: string; timestamp: number }[] {
  // IDs are already normalized at ingestion; numeric-only hex IDs must not be
  // normalized again. API dates can change across tags, pages, or snapshots:
  // retain the first recorded timestamp, especially in the exposure ledger.
  const map = new Map<string, { id: string; timestamp: number }>();
  for (const entries of [a, b]) {
    for (const x of entries) if (!map.has(x.id)) map.set(x.id, x);
  }
  return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
}
export function nextCursor(s: PrioritySnapshot) { return s.phase === "complete" ? null : { phase: s.phase, source_index: s.source_index, feed_index: s.feed_index, continuation: s.continuation }; }
export async function refreshEvidence(p: PriorityProfile, args: { start_new?: boolean; snapshot_id?: string; max_requests?: number }) {
  const max = args.max_requests ?? 25;
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("max_requests must be 1-50 base reads");
  const d = await readDecisions(p.name);
  let s: PrioritySnapshot;
  if (args.start_new) {
    if (args.snapshot_id || d.active_snapshot) throw new Error("Resume the active named snapshot before starting another");
    const now = Date.now(), cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - p.window_months);
    s = { version: 1, id: randomUUID(), config_hash: configHash(p), model: "category-beta-v1", started_at: now, completed_at: null, cutoff: cutoff.getTime(), phase: "subscriptions", source_index: 0, feed_index: 0, continuation: null, base_reads: 0, newest_item_timestamps: {}, subscriptions: [], signal_sources: [], source_coverage: {}, signals: {}, feed_ids: [], volumes: {}, prospective: {}, membership: [], errors: [] };
    // Persist decisions first: recovery may encounter a missing manifest, but never
    // silently recreate preferences after a partial first snapshot.
    d.active_snapshot = s.id; await saveDecisions(p.name, d); await saveSnapshot(p.name, s);
  } else {
    const id = args.snapshot_id ?? d.active_snapshot;
    if (!id) throw new Error("No active snapshot; explicitly pass start_new:true");
    s = await readSnapshot(p.name, id);
    if (s.phase !== "complete" && d.active_snapshot !== id) throw new Error("Snapshot is not the active collection");
  }
  if (s.config_hash !== configHash(p)) throw new Error("Snapshot config hash mismatch; do not mix evidence policies");
  let used = 0;
  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    assertBudget(1, 1, "priority collection", 25); used++; s.base_reads++;
    return apiGet<T>(path, params, { reserve: 25 });
  };
  while (used < max && s.phase !== "complete") {
    try {
      if (s.phase === "subscriptions") {
        // Validate/strip native metadata before mutating the checkpoint or preferences.
        // A malformed response then remains a recorded, resumable read failure.
        const subscriptions = validateMembership(await get<SubscriptionListResponse>("/reader/api/0/subscription/list", { output: "json" }));
        s.subscriptions = SnapshotSchema.shape.subscriptions.parse(subscriptions);
        s.membership = observeMembership(p, d, s.subscriptions, Date.now());
        await saveDecisions(p.name, d); s.phase = "metadata";
      } else if (s.phase === "metadata") {
        const data = await get<UnreadCountResponse>("/reader/api/0/unread-count", { output: "json" });
        if (!Array.isArray(data.unreadcounts) || "continuation" in data) throw new Error("Incomplete unread metadata response");
        const newest: Record<string, number> = {};
        for (const item of data.unreadcounts) {
          const micros = item.newestItemTimestampUsec;
          if (typeof micros !== "string" || !/^\d+$/.test(micros)) continue;
          const timestamp = Number(micros) / 1000;
          if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + DAY) newest[item.id] = timestamp;
        }
        s.newest_item_timestamps = newest; s.phase = "tags";
      } else if (s.phase === "tags") {
        const tags = await get<TagListResponse>("/reader/api/0/tag/list", { output: "json", types: "1" });
        if (!Array.isArray(tags.tags) || "continuation" in tags) throw new Error("Incomplete label list");
        const folders = new Set(s.subscriptions.flatMap(sub => sub.categories.map(c => c.id)));
        for (const source of p.positive_streams) {
          const canonical = canonicalStream(source);
          const tag = tags.tags.find(t => canonicalStream(t.id) === canonical);
          const explicitState = /^user\/[^/]+\/state\/com\.google\/(starred|broadcast)$/.test(source);
          if (!explicitState && (!tag || labelType(tag, folders) !== "tag")) throw new Error(`Positive source is not a verified article tag: ${source}`);
        }
        s.signal_sources = [...p.positive_streams];
        s.source_coverage = Object.fromEntries(s.signal_sources.map(id => [id, false])); s.phase = "signals";
      } else {
        const signals = s.phase === "signals";
        const id = signals ? s.signal_sources[s.source_index] : s.feed_ids[s.feed_index];
        if (!id) { s.phase = "complete"; break; }
        const params: Record<string, string> = { output: "json", n: signals ? "1000" : "10000", ot: String(Math.floor(s.cutoff / 1000)), r: "o" };
        if (!signals) params.s = id;
        if (s.continuation) params.c = s.continuation;
        const signalPage = signals ? await get<StreamContentsResponse>(`/reader/api/0/stream/contents/${encodeURIComponent(id)}`, params) : null;
        const volumePage = signals ? null : await get<StreamItemIdsResponse>("/reader/api/0/stream/items/ids", params);
        const items = signalPage?.items ?? volumePage?.itemRefs;
        const continuation = signalPage?.continuation ?? volumePage?.continuation;
        if (!Array.isArray(items)) throw new Error("Invalid article/ID response");
        const articles = items.map(item => {
          // The same API observation clock on both endpoints is essential. A
          // published/crawl fallback would silently mix two different cohorts.
          const micros = item.timestampUsec;
          const timestamp = typeof micros === "string" && /^\d+$/.test(micros) ? Number(micros) / 1000 : NaN;
          if (!item.id || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + DAY) throw new Error("Invalid or missing article timestampUsec/id; coverage incomplete");
          return { id: normalizeItemId(item.id), timestamp };
        });
        if (continuation && continuation === s.continuation) throw new Error("Repeated continuation; collection incomplete");
        if (signals) {
          const owners = new Map(Object.entries(s.signals).flatMap(([feed, entries]) => entries.map(a => [a.id, feed] as const)));
          for (let i = 0; i < signalPage!.items.length; i++) {
            const feed = signalPage!.items[i].origin?.streamId;
            if (!feed) throw new Error("Positive item missing feed origin; source coverage incomplete");
            if (owners.has(articles[i].id) && owners.get(articles[i].id) !== feed) throw new Error("Inconsistent article origin across positive sources");
            owners.set(articles[i].id, feed);
            s.signals[feed] = mergeArticles(s.signals[feed] ?? [], [articles[i]]);
          }
        } else {
          const volume = s.volumes[id] ?? { articles: [], complete: false, observed_at: null };
          volume.articles = mergeArticles(volume.articles, articles); s.volumes[id] = volume;
          if (!continuation) {
            const now = Date.now(), observation = d.observations[id];
            if (observation.last_complete === null ? now - observation.first_observed > 10 * DAY : now - observation.last_complete > 10 * DAY) observation.gap_blocked = true;
            observation.articles = mergeArticles(observation.articles, volume.articles.filter(a => a.timestamp >= observation.first_observed));
            observation.last_complete = now; volume.complete = true; volume.observed_at = now;
            s.prospective[id] = { articles: observation.articles, first_observed: observation.first_observed, gap_blocked: observation.gap_blocked };
            await saveDecisions(p.name, d);
          }
        }
        s.continuation = continuation || null;
        if (!s.continuation) {
          if (signals) {
            s.source_coverage[id] = true; s.source_index++;
            if (s.source_index === s.signal_sources.length) {
              const subscribed = new Set(s.subscriptions.map(sub => sub.id));
              s.feed_ids = [...new Set([...Object.keys(s.signals), ...s.membership, ...Object.keys(d.observations).filter(fid => d.observations[fid].last_complete !== null)])].filter(fid => subscribed.has(fid)).sort();
              s.phase = s.feed_ids.length ? "volumes" : "complete";
            }
          } else { s.feed_index++; if (s.feed_index === s.feed_ids.length) s.phase = "complete"; }
        }
      }
      s.errors = [];
    } catch (error) {
      s.errors = [String(error)]; await saveSnapshot(p.name, s); break;
    }
    // Save after EACH committed page, including the next cursor.
    await saveSnapshot(p.name, s);
  }
  if (s.phase === "complete") {
    s.completed_at ??= Date.now(); await saveSnapshot(p.name, s);
    if (d.active_snapshot === s.id) d.active_snapshot = null;
    if (d.latest_snapshot === null || (await readSnapshot(p.name, d.latest_snapshot)).started_at <= s.started_at) d.latest_snapshot = s.id;
    await saveDecisions(p.name, d);
  }
  return { profile: p.name, snapshot_id: s.id, complete: s.phase === "complete", progress: { phase: s.phase, sources_complete: Object.values(s.source_coverage).filter(Boolean).length, sources_total: p.positive_streams.length, feeds_complete: s.feed_index, feeds_total: s.feed_ids.length, errors: s.errors }, used_reads: used, total_base_reads: s.base_reads, next_cursor: nextCursor(s), cost_basis: "Base Zone 1 reads; retries up to four attempts per read cost extra and preserve 25-read reserve. No upstream writes." };
}
