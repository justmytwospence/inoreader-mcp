import type { TasteConfig } from "./config.js";

// Exact search: every vector is normalized, so cosine similarity is a dot product,
// and a scan over a few thousand 384-float rows takes milliseconds. No index needed.

/** The vectors in memory, with each item's owning sources (for tier membership). */
export interface Snapshot {
  keys: string[];
  dims: number;
  /** keys.length rows of `dims` floats. */
  data: Float32Array;
  /** key -> names of the sources that hold it. */
  owners: Map<string, Set<string>>;
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

function hits(snap: Snapshot, config: TasteConfig, query: Float32Array, min: number): Hit[] {
  if (!snap.keys.length) return [];
  const scores = scoreAll(snap, query);
  const out: Hit[] = [];
  for (let i = 0; i < snap.keys.length; i++) {
    if (scores[i] < min) continue;
    const tiers = tiersOf(config, snap.owners.get(snap.keys[i]));
    out.push({ key: snap.keys[i], similarity: scores[i], tiers, tier: tiers[0] ?? null });
  }
  return out.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1));
}

/**
 * Items of the preferred tier first (best match first), then, to fill `k`, items
 * from the other tiers. Only items at or above `minSimilarity` are returned.
 */
export function similar(
  snap: Snapshot,
  config: TasteConfig,
  query: Float32Array,
  opts: { prefer: string; k: number; minSimilarity: number },
): Hit[] {
  const all = hits(snap, config, query, opts.minSimilarity);
  const preferred = all.filter((h) => h.tiers.includes(opts.prefer));
  const rest = all.filter((h) => !h.tiers.includes(opts.prefer));
  return [...preferred, ...rest].slice(0, opts.k);
}

/** The nearest items in any tier, whatever their similarity. */
export function nearest(snap: Snapshot, config: TasteConfig, query: Float32Array, k: number): Hit[] {
  return hits(snap, config, query, -Infinity).slice(0, k);
}

export function excerptOf(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const space = cut.search(/\s\S*$/);
  return `${(space > chars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
