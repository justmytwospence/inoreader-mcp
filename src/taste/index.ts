import { join } from "node:path";
import {
  EMBED_DTYPE,
  EMBED_MODEL,
  loadTasteSettings,
  tasteEnabled,
  type TasteConfig,
  type TasteSettings,
} from "./config.js";
import type { Embedder } from "./embed.js";
import { domainMatches, domainOf, normalizeDomain, proseStats } from "./prose.js";
import { excerptOf, nearest, round3, similar, tiersOf, type Hit, type ItemFilter, type ItemMeta, type Snapshot } from "./search.js";
import { TasteStore, type ItemRow } from "./store.js";
import {
  META_LAST_SYNC,
  META_READS,
  META_SOURCES,
  runSync,
  type SourceState,
  type SyncReport,
} from "./sync.js";
import { createWorkerEmbedder } from "./worker.js";

export { tasteEnabled } from "./config.js";

export interface TasteDeps {
  store?: TasteStore;
  embedder?: Embedder;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  reads?: () => number;
}

export interface SimilarArgs extends ItemFilter {
  text: string;
  k?: number;
  prefer?: string;
  min_similarity?: number;
  excerpt_chars?: number;
  fill?: boolean;
}

export interface NoveltyArgs extends ItemFilter {
  idea: string;
  threshold?: number;
  k?: number;
}

const iso = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString() : null);

/**
 * The taste index: its store, its embedder, its sync and its two searches.
 *
 * One of these lives at module level (see getTasteIndex) because createServer runs
 * per HTTP request and must stay free of side effects. The store and the model load
 * on first use, and the model's worker unloads itself when idle.
 */
export class TasteIndex {
  readonly config: TasteConfig;
  private _store?: TasteStore;
  private _embedder?: Embedder;
  private snapshot?: Snapshot & { excluded: Record<string, number> };
  private syncing?: Promise<SyncReport>;

  constructor(
    readonly settings: TasteSettings,
    private readonly deps: TasteDeps = {},
  ) {
    this.config = settings.config;
    this._store = deps.store;
    this._embedder = deps.embedder;
  }

  get store(): TasteStore {
    if (!this._store) {
      this._store = new TasteStore(this.settings.dbPath, TasteStore.identityFor(EMBED_MODEL, EMBED_DTYPE));
      if (this._store.rebuilt) console.error("[inoreader-mcp] taste: index was damaged or from another model; rebuilding");
    }
    return this._store;
  }

  get embedder(): Embedder {
    this._embedder ??= createWorkerEmbedder({
      model: EMBED_MODEL,
      dtype: EMBED_DTYPE,
      cacheDir: join(this.settings.dataDir, "models"),
      threads: this.settings.threads,
      localModelDir: this.settings.modelDir,
    });
    return this._embedder;
  }

  /** A sync already running is joined, not repeated. */
  sync(): Promise<SyncReport> {
    if (this.syncing) return this.syncing;
    const store = this.store;
    const started = Date.now();
    this.syncing = runSync({
      store,
      embedder: this.embedder,
      config: this.config,
      env: this.deps.env,
      fetch: this.deps.fetch,
      now: this.deps.now,
      reads: this.deps.reads,
    })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        store.setJson(META_LAST_SYNC, {
          started_at: new Date(started).toISOString(),
          finished_at: new Date().toISOString(),
          outcome: "failed",
          reason: message,
          errors: [message],
        });
        throw e;
      })
      .finally(() => {
        this.syncing = undefined;
        this.snapshot = undefined;
      });
    return this.syncing;
  }

  /** The scheduler skipped a sync (e.g. the token refresh failed); status says so. */
  noteSkipped(reason: string): void {
    this.store.setJson(META_LAST_SYNC, {
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      outcome: "skipped",
      reason,
      errors: [],
    });
  }

  /**
   * The vectors plus, per item, its metadata and the sources that count it. A
   * source's exclude_domains is applied here, so a config change needs only a
   * restart: nothing is re-read or re-embedded.
   */
  private loadSnapshot(): Snapshot & { excluded: Record<string, number> } {
    if (this.snapshot) return this.snapshot;
    const m = this.store.loadMatrix();
    const meta = new Map<string, ItemMeta>();
    for (const item of this.store.allItems()) {
      meta.set(item.key, { domain: domainOf(item.url), words: item.words, ...proseStats(item.text ?? item.opening) });
    }
    const excludes = new Map(this.config.sources.map((s) => [s.name, s.exclude_domains ?? []]));
    const excluded: Record<string, number> = Object.fromEntries(this.config.sources.filter((s) => s.exclude_domains?.length).map((s) => [s.name, 0]));
    const owners = new Map<string, Set<string>>();
    for (const [key, signals] of this.store.signalsByKey()) {
      const domain = meta.get(key)?.domain ?? "";
      const counted = new Set<string>();
      for (const sig of signals) {
        const ex = excludes.get(sig.source);
        if (ex?.length && domainMatches(domain, ex)) excluded[sig.source]++;
        else counted.add(sig.source);
      }
      if (counted.size) owners.set(key, counted);
    }
    this.snapshot = { ...m, owners, meta, excluded };
    return this.snapshot;
  }

  /** The filter part of a call's arguments, validated and normalized. */
  private filterOf(args: ItemFilter): ItemFilter {
    const domains = (list: string[] | undefined, name: string) =>
      list?.map((d) => {
        const n = normalizeDomain(d);
        if (!n) throw new Error(`${name}: "${d}" is not a domain name (e.g. github.com)`);
        return n;
      });
    const known = new Set(this.config.sources.map((s) => s.name));
    const unknown = (args.sources ?? []).filter((s) => !known.has(s));
    if (unknown.length) throw new Error(`Unknown source(s) ${unknown.join(", ")}. Configured sources: ${[...known].join(", ")}.`);
    if (args.min_words !== undefined && args.max_words !== undefined && args.min_words > args.max_words) {
      throw new Error("min_words is greater than max_words");
    }
    const f: ItemFilter = {
      ...(args.min_words !== undefined ? { min_words: args.min_words } : {}),
      ...(args.max_words !== undefined ? { max_words: args.max_words } : {}),
      ...(args.include_domains?.length ? { include_domains: domains(args.include_domains, "include_domains") } : {}),
      ...(args.exclude_domains?.length ? { exclude_domains: domains(args.exclude_domains, "exclude_domains") } : {}),
      ...(args.sources?.length ? { sources: args.sources } : {}),
      ...(args.min_prose_paragraphs !== undefined ? { min_prose_paragraphs: args.min_prose_paragraphs } : {}),
    };
    return f;
  }

  coverage() {
    const store = this.store;
    const state = store.getJson<Record<string, SourceState>>(META_SOURCES, {});
    const names = this.config.sources.map((s) => s.name);
    const unsynced = names.filter((n) => !state[n]?.last_ok_at);
    const items = store.itemCount();
    const vectors = store.vectorCount();
    const last = store.getJson<SyncReport | null>(META_LAST_SYNC, null);
    const complete = unsynced.length === 0 && vectors >= items;
    return {
      items_indexed: vectors,
      sources_synced: `${names.length - unsynced.length}/${names.length}`,
      ...(unsynced.length ? { unsynced_sources: unsynced } : {}),
      ...(names.some((n) => state[n]?.last_error) ? { sources_with_errors: names.filter((n) => state[n]?.last_error) } : {}),
      last_sync_at: last?.finished_at ?? null,
      complete,
      ...(complete ? {} : { note: "The index is still building or incomplete; results cover only what is indexed so far. See taste_index_status." }),
    };
  }

  private describe(hit: Hit, excerptChars: number, withHighlights: boolean) {
    const store = this.store;
    const item = store.getItem(hit.key) as ItemRow;
    const signals = store.signalsFor(hit.key);
    // Only the sources that count the item (a source's exclude_domains drops it there).
    const owners = this.loadSnapshot().owners.get(hit.key) ?? new Set<string>();
    const meta = this.loadSnapshot().meta.get(hit.key);
    const added = signals.filter((s) => owners.has(s.source)).map((s) => s.added_at).filter((t): t is number => typeof t === "number");
    const order = this.config.sources.map((s) => s.name).filter((n) => owners.has(n));
    return {
      title: item.title,
      url: item.url,
      domain: meta?.domain ?? domainOf(item.url),
      source: item.source_title,
      published: iso(item.published),
      saved: iso(added.length ? Math.min(...added) : null),
      signals: order,
      tier: hit.tier,
      tiers: hit.tiers,
      similarity: round3(hit.similarity),
      words: item.words,
      excerpt: excerptOf(item.text ?? item.opening, excerptChars),
      ...(withHighlights
        ? {
            prose_paragraphs: meta?.prose_paragraphs ?? 0,
            prose_ratio: meta?.prose_ratio ?? 0,
            headings: item.headings,
            highlights: signals.filter((s) => owners.has(s.source)).flatMap((s) => s.highlights).map((h) => ({ text: h.text, note: h.note, added_on: iso(h.added_on) })),
          }
        : {}),
    };
  }

  private async embedOne(text: string): Promise<Float32Array> {
    // The model reads at most 512 tokens; this only bounds what is sent to the worker.
    const [vec] = await this.embedder.embed([text.slice(0, 8000)]);
    return vec;
  }

  async similar(args: SimilarArgs) {
    const k = args.k ?? 5;
    const prefer = args.prefer ?? this.config.default_tier;
    if (!this.config.tiers.some((t) => t.name === prefer)) {
      throw new Error(`Unknown tier "${prefer}". Configured tiers: ${this.config.tiers.map((t) => t.name).join(", ")}.`);
    }
    const minSimilarity = args.min_similarity ?? 0.55;
    const excerptChars = args.excerpt_chars ?? 800;
    const fill = args.fill ?? true;
    const filter = this.filterOf(args);
    const snap = this.loadSnapshot();
    const results = snap.keys.length
      ? similar(snap, this.config, await this.embedOne(args.text), { prefer, k, minSimilarity, fill, filter }).map((h) => this.describe(h, excerptChars, true))
      : [];
    return { prefer, fill, min_similarity: minSimilarity, filters: filter, count: results.length, results, coverage: this.coverage() };
  }

  async novelty(args: NoveltyArgs) {
    const threshold = args.threshold ?? this.config.novelty_threshold;
    const k = args.k ?? 3;
    const filter = this.filterOf(args);
    const snap = this.loadSnapshot();
    const top = snap.keys.length ? nearest(snap, this.config, await this.embedOne(args.idea), k, filter) : [];
    const close = top.length > 0 && top[0].similarity >= threshold;
    return {
      verdict: close ? "close" : "novel",
      threshold,
      filters: filter,
      nearest: top.map((h) => this.describe(h, 300, false)),
      note:
        "Similarity measures topical overlap with what was saved, not the quality of the idea. " +
        (top.length ? "" : "The index is empty, so nothing could be compared; 'novel' here means unknown. "),
      coverage: this.coverage(),
    };
  }

  status() {
    const store = this.store;
    const state = store.getJson<Record<string, SourceState>>(META_SOURCES, {});
    const bySource = store.countsBySource();
    const snap = this.loadSnapshot();
    const byTier: Record<string, number> = Object.fromEntries(this.config.tiers.map((t) => [t.name, 0]));
    let untiered = 0;
    for (const owners of snap.owners.values()) {
      const tiers = tiersOf(this.config, owners);
      for (const t of tiers) byTier[t]++;
      if (!tiers.length) untiered++;
    }
    const history = store.getJson<number[]>(META_READS, []);
    const last = store.getJson<SyncReport | null>(META_LAST_SYNC, null);
    const env = this.deps.env ?? process.env;
    const annotationItems = this.config.sources.filter((s) => s.type === "inoreader-annotations").reduce((n, s) => Math.max(n, bySource[s.name] ?? 0), 0);
    const streams = this.config.sources.filter((s) => s.type === "inoreader-stream").length;
    const annotationPages = this.config.sources.some((s) => s.type === "inoreader-annotations") ? Math.max(1, Math.ceil(annotationItems / 100)) : 0;
    return {
      enabled: true,
      model: { name: EMBED_MODEL, dtype: EMBED_DTYPE, dims: snap.dims || null, worker_loaded: (this._embedder as { running?: () => boolean } | undefined)?.running?.() ?? false },
      config: {
        sources: this.config.sources.map((s) => ({
          name: s.name,
          type: s.type,
          ...(s.type === "inoreader-stream" ? { stream: s.stream } : {}),
          ...(s.exclude_domains?.length ? { exclude_domains: s.exclude_domains } : {}),
          ...(s.type === "karakeep"
            ? {
                url_env: s.url_env,
                key_env: s.key_env,
                credentials_set: Boolean(env[s.url_env]?.trim() && env[s.key_env]?.trim()),
                min_words: s.min_words,
                use_reader_view: s.use_reader_view,
              }
            : {}),
        })),
        tiers: this.config.tiers,
        default_tier: this.config.default_tier,
        novelty_threshold: this.config.novelty_threshold,
      },
      counts: {
        items: store.itemCount(),
        vectors: store.vectorCount(),
        by_source: bySource,
        ...(Object.keys(snap.excluded).length ? { excluded_by_source: snap.excluded } : {}),
        searchable: snap.owners.size,
        by_tier: byTier,
        ...(untiered ? { in_no_tier: untiered } : {}),
      },
      sources: this.config.sources.map((s) => ({
        name: s.name,
        items: bySource[s.name] ?? 0,
        last_ok_at: state[s.name]?.last_ok_at ?? null,
        last_error: state[s.name]?.last_error ?? null,
        ...(state[s.name]?.note ? { note: state[s.name]!.note } : {}),
      })),
      sync: {
        running: this.syncing !== undefined,
        last: last,
        z1_reads: {
          last: last && last.outcome !== "skipped" ? last.z1_reads ?? null : null,
          recent: history,
          expected_per_sync: streams + annotationPages,
          cost_model:
            `One ids read per stream source (${streams}), one annotations read per 100 highlighted items (~${annotationPages}), ` +
            "and one content read per 20 new items (a first sync reads all of them). Karakeep is local and costs no Inoreader reads. " +
            "A sync keeps 25 Zone 1 reads in reserve and is refused, leaving the index unchanged, when quota is short.",
        },
      },
      coverage: this.coverage(),
      index_file: this.settings.dbPath,
    };
  }

  async close(): Promise<void> {
    await this._embedder?.close();
    this._store?.close();
  }
}

let instance: TasteIndex | undefined;

/** The module-level singleton, or undefined when INOREADER_TASTE_INDEX is not on. Throws on an invalid config. */
export function getTasteIndex(): TasteIndex | undefined {
  if (!tasteEnabled()) return undefined;
  return (instance ??= new TasteIndex(loadTasteSettings()));
}

/** Tests only. */
export async function resetTasteIndex(next?: TasteIndex): Promise<void> {
  await instance?.close().catch(() => {});
  instance = next;
}
