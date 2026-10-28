import { createHash } from "node:crypto";
import { BudgetError, assertBudget, getState } from "../rate-limit.js";
import type { ArticleItem } from "../types.js";
import type { KarakeepConfig, TasteConfig, TasteSource } from "./config.js";
import type { Embedder } from "./embed.js";
import { gatherKarakeep } from "./sources/karakeep.js";
import {
  RESERVE,
  candidateFromArticle,
  contentBatches,
  extIdOf,
  fetchAnnotated,
  fetchContents,
  fetchStreamIds,
  highlightsOf,
  type StreamIds,
} from "./sources/inoreader.js";
import type { ItemCandidate, SourceBatch } from "./sources/types.js";
import type { ItemRow, SignalRow, TasteStore } from "./store.js";
import { embedInput } from "./text.js";

export interface SyncDeps {
  store: TasteStore;
  embedder: Embedder;
  config: TasteConfig;
  env?: NodeJS.ProcessEnv;
  /** For Karakeep only; Inoreader goes through apiGet/apiPost. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Cumulative Zone 1 attempts, to measure what a sync cost. */
  reads?: () => number;
}

export interface SourceReport {
  ok: boolean;
  error?: string;
  new_members: number;
  removed_members: number;
}

export interface SyncReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** skipped: nothing was read or changed (budget). partial: some source failed. */
  outcome: "ok" | "partial" | "skipped";
  reason?: string;
  /** Zone 1 attempts this sync made (retries included). */
  z1_reads: number;
  sources: Record<string, SourceReport>;
  items_total: number;
  items_added: number;
  items_removed: number;
  embedded: number;
  errors: string[];
}

export interface SourceState {
  last_ok_at: string | null;
  last_error: string | null;
  note?: string;
}

export const META_LAST_SYNC = "last_sync";
export const META_SOURCES = "sources";
export const META_READS = "reads_history";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export function embedHash(row: Pick<ItemRow, "title" | "opening">): string {
  return sha1(embedInput(row.title, row.opening));
}

const isStream = (s: TasteSource): s is Extract<TasteSource, { type: "inoreader-stream" }> => s.type === "inoreader-stream";
const isAnnotations = (s: TasteSource) => s.type === "inoreader-annotations";
const isKarakeep = (s: TasteSource): s is KarakeepConfig => s.type === "karakeep";

/** Reads (in Zone 1) the Inoreader part of a sync costs at least: one ids call per stream, one annotations page. */
export function minimumInoreaderReads(config: TasteConfig): number {
  return config.sources.filter(isStream).length + (config.sources.some(isAnnotations) ? 1 : 0);
}

function widestTier(config: TasteConfig): string {
  return config.tiers[config.tiers.length - 1].name;
}

/** An item keeps its full cleaned text unless it belongs only to the widest tier (or to none). */
export function retainsText(config: TasteConfig, sources: Set<string>): boolean {
  const widest = widestTier(config);
  return config.tiers.some((t) => t.name !== widest && t.sources.some((s) => sources.has(s)));
}

/**
 * Prefers the candidate with more text, which is how a teaser-only feed item falls
 * back to Karakeep's crawl of the same URL. Ties keep what is stored, so a re-read
 * never flips an item between two equally good copies (and never re-embeds it).
 */
function mergeCandidate(existing: ItemRow | undefined, c: ItemCandidate, now: number): ItemRow {
  if (existing && existing.words >= c.words) {
    return {
      ...existing,
      source_title: existing.source_title || c.source_title,
      published: existing.published ?? c.published,
      text: existing.text ?? c.text,
    };
  }
  return {
    key: c.key,
    url: existing?.url ?? c.url,
    title: c.title,
    source_title: c.source_title || existing?.source_title || "",
    published: c.published ?? existing?.published ?? null,
    opening: c.opening,
    headings: c.headings,
    words: c.words,
    text: c.text,
    updated_at: now,
  };
}

/**
 * One sync: read every source, then write everything in one transaction.
 *
 * - A budget refusal (before or during the reads) abandons the sync with the index
 *   untouched. Reads already spent are not wasted: they are in the report.
 * - Any other failure takes down only its source: its stored members are kept and
 *   the error is reported by taste_index_status.
 * - Embedding runs before the write. If the model cannot load, items are stored
 *   without vectors and the next sync embeds them.
 */
export async function runSync(deps: SyncDeps): Promise<SyncReport> {
  const { store, embedder, config } = deps;
  const now = deps.now ?? Date.now;
  const readCount = deps.reads ?? (() => getState().zone1.attemptCount ?? 0);
  const startedMs = now();
  const readsBefore = readCount();

  const sources: Record<string, SourceReport> = {};
  const failed = new Map<string, string>();
  const batches: SourceBatch[] = [];
  const fail = (name: string, e: unknown) => {
    if (e instanceof BudgetError) throw e;
    failed.set(name, errText(e));
  };

  const finish = (partial: Partial<SyncReport> & { outcome: SyncReport["outcome"] }): SyncReport => {
    const report: SyncReport = {
      started_at: new Date(startedMs).toISOString(),
      finished_at: new Date(now()).toISOString(),
      duration_ms: now() - startedMs,
      z1_reads: readCount() - readsBefore,
      sources,
      items_total: 0,
      items_added: 0,
      items_removed: 0,
      embedded: 0,
      errors: [...failed].map(([n, m]) => `${n}: ${m}`),
      ...partial,
    };
    store.setJson(META_LAST_SYNC, report);
    const history = store.getJson<number[]>(META_READS, []);
    if (report.outcome !== "skipped") store.setJson(META_READS, [...history, report.z1_reads].slice(-10));
    return report;
  };

  try {
    const streamSources = config.sources.filter(isStream);
    const annotationSources = config.sources.filter(isAnnotations);
    const karakeepSources = config.sources.filter(isKarakeep);
    if (streamSources.length || annotationSources.length) {
      assertBudget(1, minimumInoreaderReads(config), "taste sync", RESERVE);
    }

    // --- read: Inoreader ---------------------------------------------------
    const cache = new Map<string, ArticleItem>();
    const idsBySource = new Map<string, StreamIds>();
    for (const s of streamSources) {
      try {
        idsBySource.set(s.name, await fetchStreamIds(s.stream));
      } catch (e) {
        fail(s.name, e);
      }
    }

    let annotated: Awaited<ReturnType<typeof fetchAnnotated>> | undefined;
    if (annotationSources.length) {
      try {
        annotated = await fetchAnnotated();
        for (const item of annotated.items) cache.set(extIdOf(item.id), item);
      } catch (e) {
        for (const s of annotationSources) fail(s.name, e);
      }
    }

    // New ids, once across all stream sources, minus what the index or this sync already has.
    const need = new Map<string, string>();
    for (const [name, ids] of idsBySource) {
      const known = store.signalsOf(name);
      for (const r of ids.refs) {
        if (known.has(r.ext) || cache.has(r.ext) || store.keyOfExtId(r.ext)) continue;
        need.set(r.ext, r.raw);
      }
    }
    let unfetched = new Set<string>();
    let contentError: string | undefined;
    if (need.size) {
      assertBudget(1, contentBatches(need.size), "taste sync content", RESERVE);
      const got = await fetchContents([...need.values()]);
      for (const [ext, item] of got.items) cache.set(ext, item);
      unfetched = got.failed;
      contentError = got.error;
    }

    for (const s of streamSources) {
      const ids = idsBySource.get(s.name);
      if (!ids) continue;
      const known = store.signalsOf(s.name);
      const upserts: SignalRow[] = [];
      const candidates: ItemCandidate[] = [];
      let skipped = 0;
      for (const r of ids.refs) {
        if (known.has(r.ext)) continue;
        // Its content batch failed: not recorded, so the next sync fetches it again.
        if (unfetched.has(r.raw)) {
          skipped++;
          continue;
        }
        const prior = store.keyOfExtId(r.ext);
        if (prior) {
          upserts.push({ source: s.name, ext_id: r.ext, key: prior.key, fp: "", added_at: null, highlights: [] });
          continue;
        }
        const item = cache.get(r.ext);
        const cand = item ? candidateFromArticle(item) : null;
        if (cand) candidates.push(cand);
        upserts.push({ source: s.name, ext_id: r.ext, key: cand?.key ?? null, fp: item ? "" : "missing", added_at: null, highlights: [] });
      }
      if (skipped) failed.set(s.name, `${skipped} new item(s) not fetched, retried next sync: ${contentError}`);
      // A stream longer than the ids limit lists only its newest items, so absence proves nothing.
      batches.push({ source: s.name, present: ids.truncated ? null : new Set(ids.refs.map((r) => r.ext)), upserts, candidates });
    }

    if (annotated) {
      for (const s of annotationSources) {
        const upserts: SignalRow[] = [];
        const candidates: ItemCandidate[] = [];
        for (const item of annotated.items) {
          const ext = extIdOf(item.id);
          const cand = candidateFromArticle(item);
          if (cand) candidates.push(cand);
          const highlights = highlightsOf(item);
          const times = highlights.map((h) => h.added_on).filter((t): t is number => t !== null);
          upserts.push({
            source: s.name, ext_id: ext, key: cand?.key ?? null, fp: "",
            added_at: times.length ? Math.min(...times) : null, highlights,
          });
        }
        batches.push({
          source: s.name,
          present: annotated.complete ? new Set(annotated.items.map((i) => extIdOf(i.id))) : null,
          upserts,
          candidates,
        });
      }
    }

    // --- read: Karakeep (local, unmetered) --------------------------------------
    for (const s of karakeepSources) {
      try {
        batches.push(await gatherKarakeep(s, store, { env: deps.env, fetch: deps.fetch }));
      } catch (e) {
        fail(s.name, e);
      }
    }
  } catch (e) {
    if (e instanceof BudgetError) {
      return finish({ outcome: "skipped", reason: e.message, items_total: store.itemCount() });
    }
    throw e;
  }

  // --- merge in memory --------------------------------------------------------
  const best = new Map<string, ItemCandidate>();
  for (const b of batches) {
    for (const c of b.candidates) {
      const prev = best.get(c.key);
      if (!prev || c.words > prev.words) best.set(c.key, c);
    }
  }
  const stamp = Math.floor(now() / 1000);
  const merged = new Map<string, ItemRow>();
  let itemsAdded = 0;
  for (const [key, c] of best) {
    const existing = store.getItem(key);
    if (!existing) itemsAdded++;
    merged.set(key, mergeCandidate(existing, c, stamp));
  }

  // --- embed what is new, changed or missing ------------------------------------
  const have = store.vectorHashes();
  const toEmbed = new Map<string, ItemRow>();
  for (const [key, row] of merged) if (have.get(key) !== embedHash(row)) toEmbed.set(key, row);
  if (store.itemCount() !== have.size) {
    for (const row of store.allItems()) if (!have.has(row.key) && !toEmbed.has(row.key)) toEmbed.set(row.key, row);
  }
  const vectors = new Map<string, { hash: string; vec: Float32Array }>();
  if (toEmbed.size) {
    const rows = [...toEmbed.values()];
    try {
      const out = await embedder.embed(rows.map((r) => embedInput(r.title, r.opening)));
      rows.forEach((r, i) => vectors.set(r.key, { hash: embedHash(r), vec: out[i] }));
    } catch (e) {
      failed.set("embedding", errText(e));
    }
  }

  // --- write, all or nothing ----------------------------------------------------
  const iso = new Date(now()).toISOString();
  let removedItems = 0;
  store.transaction(() => {
    store.pruneSources(config.sources.map((s) => s.name));
    const prior = store.getJson<Record<string, SourceState>>(META_SOURCES, {});
    const state: Record<string, SourceState> = {};
    for (const s of config.sources) state[s.name] = prior[s.name] ?? { last_ok_at: null, last_error: null };

    for (const b of batches) {
      const known = store.signalsOf(b.source);
      const gone = b.present ? [...known.keys()].filter((id) => !b.present!.has(id)) : [];
      store.deleteSignals(b.source, gone);
      let added = 0;
      for (const u of b.upserts) {
        if (!known.has(u.ext_id)) added++;
        store.putSignal(u);
      }
      sources[b.source] = { ok: true, new_members: added, removed_members: gone.length };
      state[b.source] = { last_ok_at: iso, last_error: null, ...(b.present ? {} : { note: "listing incomplete; removals not applied" }) };
    }
    for (const [name, message] of failed) {
      if (!state[name]) continue; // "embedding" is not a source
      // A source can have applied part of its batch (some content batches failed): keep its counts.
      sources[name] = { ...(sources[name] ?? { new_members: 0, removed_members: 0 }), ok: false, error: message };
      state[name] = { ...state[name], last_error: message };
    }

    const bySource = store.signalsByKey();
    for (const [key, row] of merged) {
      const owners = new Set((bySource.get(key) ?? []).map((s) => s.source));
      store.upsertItem({ ...row, text: retainsText(config, owners) ? row.text : null });
    }
    for (const [key, v] of vectors) store.putVector(key, v.hash, v.vec);
    removedItems = store.gc();
    store.setJson(META_SOURCES, state);
  });

  return finish({
    outcome: failed.size ? "partial" : "ok",
    items_total: store.itemCount(),
    items_added: itemsAdded,
    items_removed: removedItems,
    embedded: vectors.size,
  });
}
