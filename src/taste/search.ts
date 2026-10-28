import type { TasteConfig } from "./config.js";
import { domainMatches, type ProseStats } from "./prose.js";

// Exact search: every vector is normalized, so cosine similarity is a dot product,
// and a scan over a few thousand 384-float rows takes milliseconds. No index needed.

/** The vectors in memory, with each item's owning sources (for tier membership). */
export interface Snapshot {
  keys: string[];
  dims: number;
  /** keys.length rows of `dims` floats. */
  data: Float32Array;
  /**
   * key -> names of the sources that hold it, after each source's exclude_domains.
   * An item with no source left is absent: it is not searched at all.
   */
  owners: Map<string, Set<string>>;
  /** key -> what filters and clients use; every item with a vector has one. */
  meta: Map<string, ItemMeta>;
}

export interface ItemMeta extends ProseStats {
  /** Host without `www.`. */
  domain: string;
  words: number;
}

/** Composable result filters; every field is optional and all given ones must pass. */
export interface ItemFilter {
  min_words?: number;
  max_words?: number;
  /** Only these domains (or their subdomains). */
  include_domains?: string[];
  /** Not these domains (or their subdomains). */
  exclude_domains?: string[];
  /** Only items held by at least one of these sources. */
  sources?: string[];
  /** At least this many prose paragraphs in the opening. */
  min_prose_paragraphs?: number;
}

export function passes(meta: ItemMeta | undefined, owners: Set<string>, f: ItemFilter): boolean {
  if (!meta) return false;
  if (f.min_words !== undefined && meta.words < f.min_words) return false;
  if (f.max_words !== undefined && meta.words > f.max_words) return false;
  if (f.include_domains?.length && !domainMatches(meta.domain, f.include_domains)) return false;
  if (f.exclude_domains?.length && domainMatches(meta.domain, f.exclude_domains)) return false;
  if (f.sources?.length && !f.sources.some((s) => owners.has(s))) return false;
  if (f.min_prose_paragraphs !== undefined && meta.prose_paragraphs < f.min_prose_paragraphs) return false;
  return true;
}

export interface Hit {
  key: string;
  similarity: number;
  /** Every tier the item belongs to, narrowest first. */
  tiers: string[];
  /** The narrowest tier it belongs to, or null if it belongs to none. */
  tier: string | null;
}

export function tiersOf(config: TasteConfig, owners: Set<string> | undefined): string[] {
  if (!owners) return [];
  return config.tiers.filter((t) => t.sources.some((s) => owners.has(s))).map((t) => t.name);
}

export function scoreAll(snap: Snapshot, query: Float32Array): Float32Array {
  const { dims, data, keys } = snap;
  if (query.length !== dims) throw new Error(`query has ${query.length} dimensions but the index has ${dims}`);
  const scores = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    let dot = 0;
    const base = i * dims;
    for (let d = 0; d < dims; d++) dot += data[base + d] * query[d];
    scores[i] = dot;
  }
  return scores;
}

function hits(snap: Snapshot, config: TasteConfig, query: Float32Array, min: number, filter: ItemFilter = {}): Hit[] {
  if (!snap.keys.length) return [];
  const scores = scoreAll(snap, query);
  const out: Hit[] = [];
  for (let i = 0; i < snap.keys.length; i++) {
    if (scores[i] < min) continue;
    const key = snap.keys[i];
    const owners = snap.owners.get(key);
    if (!owners?.size || !passes(snap.meta.get(key), owners, filter)) continue;
    const tiers = tiersOf(config, owners);
    out.push({ key, similarity: scores[i], tiers, tier: tiers[0] ?? null });
  }
  return out.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1));
}

/**
 * Items of the preferred tier first (best match first), then, to fill `k` (unless
 * `fill` is false), items from the other tiers. Only items at or above
 * `minSimilarity` that pass `filter` are returned.
 */
export function similar(
  snap: Snapshot,
  config: TasteConfig,
  query: Float32Array,
  opts: { prefer: string; k: number; minSimilarity: number; fill?: boolean; filter?: ItemFilter },
): Hit[] {
  const all = hits(snap, config, query, opts.minSimilarity, opts.filter);
  const preferred = all.filter((h) => h.tiers.includes(opts.prefer));
  const rest = opts.fill === false ? [] : all.filter((h) => !h.tiers.includes(opts.prefer));
  return [...preferred, ...rest].slice(0, opts.k);
}

/** The nearest items in any tier that pass `filter`, whatever their similarity. */
export function nearest(snap: Snapshot, config: TasteConfig, query: Float32Array, k: number, filter: ItemFilter = {}): Hit[] {
  return hits(snap, config, query, -Infinity, filter).slice(0, k);
}

export function excerptOf(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const space = cut.search(/\s\S*$/);
  return `${(space > chars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
