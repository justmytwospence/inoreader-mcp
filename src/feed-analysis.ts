import type { ArticleItem } from "./types.js";
import { betaQuantile } from "./statistics/beta.js";

export interface BetaPrior { alpha: number; beta: number }
export interface FeedCounts {
  stream_id: string;
  folders: string[];
  k: number;
  n: number;
  volume_complete?: boolean;
  engagement_complete?: boolean;
}
export interface PriorReport {
  global: BetaPrior & { rate: number };
  by_category: Record<string, BetaPrior & { rate: number }>;
  fallback_categories: string[];
  /** Observations actually admitted to the global pool; zero means insufficient evidence. */
  global_observations?: number;
  global_stabilized?: boolean;
  stabilized_categories?: string[];
}
export interface FeedPosterior {
  alpha: number;
  beta: number;
  mean: number;
  ci_low: number;
  ci_high: number;
}

/** The caller selects positive streams; an ordinary read flag is never a signal here. */
export function countEngagement(items: ArticleItem[]): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of items) {
    const feed = item.origin?.streamId;
    if (!feed || seen.has(item.id)) continue;
    seen.add(item.id);
    counts.set(feed, (counts.get(feed) ?? 0) + 1);
  }
  return counts;
}

function validCounts(k: number, n: number): boolean {
  return Number.isSafeInteger(k) && Number.isSafeInteger(n) && k >= 0 && n >= k;
}

/** Category pools require two engaged feeds, otherwise they inherit the global pool.
 * Explicitly incomplete or inconsistent observations are never used to fit priors.
 * Unsampled feeds must be omitted (not supplied as a fabricated zero denominator).
 */
export function fitCategoryPriors(feeds: FeedCounts[], excludedFolders: string[], strength: number): PriorReport {
  if (!Number.isFinite(strength) || strength <= 0) throw new RangeError("Prior strength must be positive and finite");
  const excluded = new Set(excludedFolders.map(folder => folder.trim().toLowerCase()));
  const usable = feeds.filter((feed) => validCounts(feed.k, feed.n) && feed.n > 0 &&
    feed.volume_complete !== false && feed.engagement_complete !== false);
  const pool = (members: FeedCounts[]) => {
    const k = members.reduce((sum, feed) => sum + feed.k, 0);
    const n = members.reduce((sum, feed) => sum + feed.n, 0);
    const raw = n > 0 ? k / n : 0;
    const stabilized = raw === 0 || raw === 1;
    const rate = stabilized ? (k + 0.5) / (n + 1) : raw;
    // Compute the complement directly at the boundary; 1 - rate can round to
    // zero for very large all-success pools despite Jeffreys stabilization.
    const complement = stabilized ? (n - k + 0.5) / (n + 1) : (n - k) / n;
    return { prior: { alpha: rate * strength, beta: complement * strength, rate }, n, stabilized };
  };
  const global = pool(usable);
  const byCategory: PriorReport["by_category"] = Object.create(null);
  const fallback: string[] = [];
  const stabilized: string[] = [];
  const categories = new Set(feeds.flatMap((feed) => feed.folders).filter((folder) => !excluded.has(folder.trim().toLowerCase())));
  for (const category of categories) {
    const members = usable.filter((feed) => feed.folders.includes(category));
    if (members.filter((feed) => feed.k > 0).length < 2) {
      byCategory[category] = { ...global.prior };
      fallback.push(category);
    } else {
      const fitted = pool(members);
      byCategory[category] = fitted.prior;
      if (fitted.stabilized) stabilized.push(category);
    }
  }
  return {
    global: global.prior,
    by_category: byCategory,
    fallback_categories: fallback,
    global_observations: global.n,
    global_stabilized: global.stabilized,
    stabilized_categories: stabilized,
  };
}

/** Equal-tailed 90% interval from the exact Beta CDF, not a normal approximation. */
export function feedPosterior(k: number, n: number, prior: BetaPrior): FeedPosterior {
  if (!validCounts(k, n)) throw new RangeError("Counts must be nonnegative safe integers with k <= n");
  if (!Number.isFinite(prior.alpha) || prior.alpha <= 0 || !Number.isFinite(prior.beta) || prior.beta <= 0) {
    throw new RangeError("Beta prior shapes must be positive and finite");
  }
  const alpha = prior.alpha + k;
  const beta = prior.beta + n - k;
  return { alpha, beta, mean: alpha / (alpha + beta), ci_low: betaQuantile(0.05, alpha, beta), ci_high: betaQuantile(0.95, alpha, beta) };
}
