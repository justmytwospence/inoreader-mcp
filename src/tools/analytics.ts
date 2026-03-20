import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, invalidateCache } from "../api.js";
import { getState } from "../rate-limit.js";
import type {
  SubscriptionListResponse,
  UnreadCountResponse,
  StreamContentsResponse,
  StreamItemIdsResponse,
  TagListResponse,
  UserInfoResponse,
} from "../types.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.tool(
    "analyze_feeds",
    "Analyze feed health and engagement using a Beta-Binomial Bayesian model with category-level pooling. Counts articles with any engagement signal (starred, liked, broadcast, or custom tags) as engaged, deduplicating across tags. Computes engagement_rate as the posterior mean of engaged/total per feed, with an empirical Bayes prior estimated per folder category. Feeds in multiple folders average their category priors. Categories with fewer than 2 engaged feeds fall back to the global prior. This shrinks small-sample feeds toward their category mean, preventing feeds with 1/1 engaged from dominating. Also provides credible_lower (90% credible interval lower bound) for conservative ranking. Default sort is unengaged_per_month, which ranks feeds by estimated wasted articles per month ((1 - engagement_rate) * volume / months) to surface pruning candidates. Results are cached permanently until refresh is set or a write operation occurs. Costs 3 + engagement_pages + volume_feeds Zone 1 requests on first call (volume_feeds = engaged feeds + volume_sample), 0 on subsequent cached calls.",
    {
      folder: z
        .string()
        .optional()
        .describe("Limit analysis to feeds in this folder"),
      months: z
        .number()
        .min(1)
        .max(24)
        .optional()
        .describe("Time window in months to analyze (default 3)"),
      sort_by: z
        .enum(["engagement_rate", "credible_lower", "engaged_count", "title", "days_since_newest", "unengaged_per_month"])
        .optional()
        .describe("Sort results by (default: unengaged_per_month). unengaged_per_month ranks by estimated wasted articles per month to surface pruning candidates. Use credible_lower for conservative ranking that penalizes small samples more."),
      prior_strength: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Beta prior pseudo-observation count (default 10). Higher values shrink small-sample feeds more aggressively toward the global mean."),
      engagement_pages: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max total pages of engaged articles to fetch across all engagement tags (100 per page, default 10). More pages = better data but higher API cost."),
      volume_sample: z
        .number()
        .min(0)
        .max(200)
        .optional()
        .describe("How many never-engaged active feeds to also count volume for, to rank noise (default 0). Set higher to find the noisiest unengaged feeds, at 1 extra API call each."),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Max number of feeds to return (default 100). Use to keep response size manageable."),
      refresh: z
        .boolean()
        .optional()
        .describe("Force fresh data by clearing the cache before running (default false)"),
    },
    async (params) => {
      if (params.refresh) invalidateCache();

      const monthsBack = params.months ?? 3;
      const sinceTimestamp = String(
        Math.floor((Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000) / 1000)
      );

      // Fetch subscriptions, unread counts, and tags in parallel (3 Z1)
      const [subData, unreadData, tagData] = await Promise.all([
        apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", {
          output: "json",
        }),
        apiGet<UnreadCountResponse>("/reader/api/0/unread-count", {
          output: "json",
        }),
        apiGet<TagListResponse>("/reader/api/0/tag/list", {
          output: "json",
        }),
      ]);

      // Build subscription-date lookup (firstitemmsec = first item available, proxy for subscribe date)
      const feedFirstItemSec = new Map<string, number>();
      for (const sub of subData.subscriptions) {
        if (sub.firstitemmsec) {
          feedFirstItemSec.set(sub.id, Math.floor(parseInt(sub.firstitemmsec) / 1_000_000));
        }
      }

      // Determine which tags represent engagement (not folders or passive states)
      const folderIds = new Set<string>();
      for (const sub of subData.subscriptions) {
        for (const cat of sub.categories) {
          folderIds.add(cat.id);
        }
      }
      const excludedSuffixes = [
        "state/com.google/read",
        "state/com.google/reading-list",
        "state/com.google/tracking-body-link-used",
        "state/com.google/tracking-emailed",
        "state/com.google/tracking-item-link-used",
        "state/com.google/tracking-kept-unread",
      ];
      const engagementTagIds = tagData.tags
        .map((t) => t.id)
        .filter((id) => {
          if (folderIds.has(id)) return false;
          if (excludedSuffixes.some((suffix) => id.endsWith(suffix))) return false;
          return true;
        });

      // Fetch engaged articles across all engagement tags with deduplication
      const engagedCountByFeed = new Map<string, number>();
      const seenArticleIds = new Set<string>();
      const maxPages = params.engagement_pages ?? 10;
      let totalEngaged = 0;
      let pagesUsed = 0;
      let z1Cost = 3; // subscriptions + unread counts + tag list

      for (const tagId of engagementTagIds) {
        if (pagesUsed >= maxPages) break;
        let continuation: string | undefined;

        while (pagesUsed < maxPages) {
          const queryParams: Record<string, string> = {
            output: "json",
            n: "100",
            ot: sinceTimestamp,
          };
          if (continuation) queryParams.c = continuation;

          let data: StreamContentsResponse;
          try {
            data = await apiGet<StreamContentsResponse>(
              `/reader/api/0/stream/contents/${encodeURIComponent(tagId)}`,
              queryParams
            );
          } catch {
            break; // Tag stream not fetchable, skip it
          }
          pagesUsed++;
          z1Cost++;

          for (const item of data.items) {
            if (seenArticleIds.has(item.id)) continue;
            seenArticleIds.add(item.id);
            const feedId = item.origin?.streamId;
            if (feedId) {
              engagedCountByFeed.set(feedId, (engagedCountByFeed.get(feedId) ?? 0) + 1);
              totalEngaged++;
            }
          }

          if (!data.continuation) break;
          continuation = data.continuation;
        }
      }

      // Build unread map for dormancy checks
      const unreadMap = new Map(
        unreadData.unreadcounts.map((c) => [
          c.id,
          {
            count: c.count,
            newestItemTimestamp: parseInt(c.newestItemTimestampUsec) / 1000,
          },
        ])
      );

      // Helper to fetch article count for a single feed in the window
      const totalArticlesByFeed = new Map<string, number>();
      const feedEffectiveMonths = new Map<string, number>();

      async function countFeedArticles(feedId: string): Promise<void> {
        try {
          const feedStartSec = feedFirstItemSec.get(feedId);
          const effectiveStartSec = feedStartSec
            ? Math.max(parseInt(sinceTimestamp), feedStartSec)
            : parseInt(sinceTimestamp);

          const effectiveMonths = Math.max(
            (Date.now() / 1000 - effectiveStartSec) / (30 * 24 * 60 * 60),
            0.1
          );
          feedEffectiveMonths.set(feedId, effectiveMonths);

          const data = await apiGet<StreamItemIdsResponse>(
            "/reader/api/0/stream/items/ids",
            {
              s: feedId,
              ot: String(effectiveStartSec),
              n: "10000",
              output: "json",
            }
          );
          z1Cost++;
          totalArticlesByFeed.set(feedId, (data.itemRefs ?? []).length);
        } catch {
          // Feed may no longer be valid
        }
      }

      // 1. Always fetch volume for engaged feeds (needed for engagement_rate)
      const engagedFeedIds = [...engagedCountByFeed.keys()];
      const BATCH_SIZE = 50;
      for (let i = 0; i < engagedFeedIds.length; i += BATCH_SIZE) {
        const batch = engagedFeedIds.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(countFeedArticles));
      }

      // 2. Optionally fetch volume for a sample of never-engaged active feeds
      const volumeSample = params.volume_sample ?? 0;
      if (volumeSample > 0) {
        const now = Date.now();
        const engagedFeedIdSet = new Set(engagedFeedIds);
        const neverEngagedActive = subData.subscriptions
          .filter((sub) => {
            if (engagedFeedIdSet.has(sub.id)) return false;
            const unread = unreadMap.get(sub.id);
            if (!unread?.newestItemTimestamp) return false;
            const daysSince = (now - unread.newestItemTimestamp) / (1000 * 60 * 60 * 24);
            return daysSince <= 90;
          })
          .sort((a, b) => {
            // Sort by most recently active first
            const aTime = unreadMap.get(a.id)?.newestItemTimestamp ?? 0;
            const bTime = unreadMap.get(b.id)?.newestItemTimestamp ?? 0;
            return bTime - aTime;
          })
          .slice(0, volumeSample)
          .map((sub) => sub.id);

        for (let i = 0; i < neverEngagedActive.length; i += BATCH_SIZE) {
          const batch = neverEngagedActive.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(countFeedArticles));
        }
      }

      // Build category -> feed IDs mapping (feeds appear in ALL their categories)
      const categoryFeedIds = new Map<string, string[]>();
      for (const sub of subData.subscriptions) {
        for (const cat of sub.categories) {
          if (!categoryFeedIds.has(cat.label)) categoryFeedIds.set(cat.label, []);
          categoryFeedIds.get(cat.label)!.push(sub.id);
        }
      }

      // Compute global empirical Bayes prior (fallback)
      const priorStrength = params.prior_strength ?? 10;
      let globalEngaged = 0;
      let globalTotal = 0;
      for (const feedId of engagedFeedIds) {
        const total = totalArticlesByFeed.get(feedId);
        if (total !== undefined) {
          globalEngaged += engagedCountByFeed.get(feedId) ?? 0;
          globalTotal += total;
        }
      }
      const globalRate = globalTotal > 0 ? globalEngaged / globalTotal : 0;
      const globalAlpha = globalRate * priorStrength;
      const globalBeta = (1 - globalRate) * priorStrength;

      // Compute per-category priors (categories with >= 2 engaged feeds)
      const minCategoryFeeds = 2;
      const categoryPriors = new Map<string, { alpha: number; beta: number; rate: number; fallback: boolean }>();
      const fallbackCategories: string[] = [];

      for (const [category, feedIds] of categoryFeedIds) {
        let catEngaged = 0;
        let catTotal = 0;
        let engagedFeedCount = 0;
        for (const fid of feedIds) {
          const eng = engagedCountByFeed.get(fid);
          const tot = totalArticlesByFeed.get(fid);
          if (eng !== undefined && eng > 0 && tot !== undefined) {
            catEngaged += eng;
            catTotal += tot;
            engagedFeedCount++;
          }
        }
        if (engagedFeedCount >= minCategoryFeeds && catTotal > 0) {
          const rate = catEngaged / catTotal;
          categoryPriors.set(category, {
            alpha: rate * priorStrength,
            beta: (1 - rate) * priorStrength,
            rate,
            fallback: false,
          });
        } else {
          categoryPriors.set(category, {
            alpha: globalAlpha,
            beta: globalBeta,
            rate: globalRate,
            fallback: true,
          });
          fallbackCategories.push(category);
        }
      }

      // Resolve per-feed prior by averaging across all the feed's categories
      const feedPriors = new Map<string, { alpha: number; beta: number }>();
      for (const sub of subData.subscriptions) {
        if (sub.categories.length === 0) {
          feedPriors.set(sub.id, { alpha: globalAlpha, beta: globalBeta });
          continue;
        }
        const priors = sub.categories
          .map((c) => categoryPriors.get(c.label))
          .filter((p): p is NonNullable<typeof p> => p !== undefined);
        if (priors.length === 0) {
          feedPriors.set(sub.id, { alpha: globalAlpha, beta: globalBeta });
        } else {
          feedPriors.set(sub.id, {
            alpha: priors.reduce((sum, p) => sum + p.alpha, 0) / priors.length,
            beta: priors.reduce((sum, p) => sum + p.beta, 0) / priors.length,
          });
        }
      }

      let feeds = subData.subscriptions.map((sub) => {
        const unread = unreadMap.get(sub.id);
        const newestItemDate = unread?.newestItemTimestamp
          ? new Date(unread.newestItemTimestamp).toISOString()
          : null;
        const daysSinceNewest = unread?.newestItemTimestamp
          ? (Date.now() - unread.newestItemTimestamp) / (1000 * 60 * 60 * 24)
          : null;
        const engagedCount = engagedCountByFeed.get(sub.id) ?? 0;
        const totalArticles = totalArticlesByFeed.get(sub.id) ?? null;

        // Beta-Binomial posterior mean (using category-averaged prior)
        const prior = feedPriors.get(sub.id) ?? { alpha: globalAlpha, beta: globalBeta };
        let engagementRate: number | null;
        let credibleLower: number | null;
        if (engagedCount > 0 && totalArticles !== null && totalArticles > 0) {
          const n = totalArticles;
          const posteriorAlpha = prior.alpha + engagedCount;
          const posteriorBeta = prior.beta + n - engagedCount;
          const posteriorN = posteriorAlpha + posteriorBeta;
          engagementRate = posteriorAlpha / posteriorN;
          // Normal approximation to 90% credible interval lower bound
          const variance = (posteriorAlpha * posteriorBeta) / (posteriorN * posteriorN * (posteriorN + 1));
          credibleLower = Math.max(0, engagementRate - 1.645 * Math.sqrt(variance));
        } else if (engagedCount > 0) {
          // Engaged articles exist but total count fetch failed
          engagementRate = null;
          credibleLower = null;
        } else if (totalArticles !== null) {
          // Volume known but zero engagement
          engagementRate = 0;
          credibleLower = 0;
        } else {
          // No volume data (never-engaged, not sampled)
          engagementRate = 0;
          credibleLower = 0;
        }

        let status: "high-engagement" | "moderate-engagement" | "never-engaged" | "dormant";
        if (daysSinceNewest !== null && daysSinceNewest > 90) {
          status = "dormant";
        } else if (engagementRate !== null && engagementRate > 0.1) {
          status = "high-engagement";
        } else if (engagedCount > 0) {
          status = "moderate-engagement";
        } else {
          status = "never-engaged";
        }

        return {
          title: sub.title,
          id: sub.id,
          folders: sub.categories.map((c) => c.label),
          engaged_count: engagedCount,
          total_articles: totalArticles,
          engagement_rate: engagementRate !== null ? Math.round(engagementRate * 10000) / 10000 : null,
          credible_lower: credibleLower !== null ? Math.round(credibleLower * 10000) / 10000 : null,
          newest_item_date: newestItemDate,
          days_since_newest: daysSinceNewest ? Math.round(daysSinceNewest) : null,
          unengaged_per_month: engagementRate !== null && totalArticles !== null
            ? Math.round((1 - engagementRate) * totalArticles / (feedEffectiveMonths.get(sub.id) ?? monthsBack) * 100) / 100
            : null,
          status,
        };
      });

      if (params.folder) {
        feeds = feeds.filter((f) =>
          f.folders.some(
            (folder) => folder.toLowerCase() === params.folder!.toLowerCase()
          )
        );
      }

      const sortBy = params.sort_by ?? "unengaged_per_month";
      if (sortBy === "engagement_rate") {
        feeds.sort((a, b) => (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1));
      } else if (sortBy === "credible_lower") {
        feeds.sort((a, b) => (b.credible_lower ?? -1) - (a.credible_lower ?? -1));
      } else if (sortBy === "engaged_count") {
        feeds.sort((a, b) => b.engaged_count - a.engaged_count);
      } else if (sortBy === "days_since_newest") {
        feeds.sort((a, b) => (b.days_since_newest ?? 9999) - (a.days_since_newest ?? 9999));
      } else if (sortBy === "unengaged_per_month") {
        feeds.sort((a, b) => (b.unengaged_per_month ?? -1) - (a.unengaged_per_month ?? -1));
      } else {
        feeds.sort((a, b) => a.title.localeCompare(b.title));
      }

      const summary = {
        total_feeds: feeds.length,
        high_engagement: feeds.filter((f) => f.status === "high-engagement").length,
        moderate_engagement: feeds.filter((f) => f.status === "moderate-engagement").length,
        never_engaged: feeds.filter((f) => f.status === "never-engaged").length,
        dormant: feeds.filter((f) => f.status === "dormant").length,
        window_months: monthsBack,
        engaged_articles_scanned: totalEngaged,
        has_more_engaged: pagesUsed >= maxPages,
        engagement_tags_used: engagementTagIds.length,
        engagement_tag_ids: engagementTagIds,
        api_cost_z1: z1Cost,
        volume_feeds_counted: totalArticlesByFeed.size,
        prior: {
          strength: priorStrength,
          global_fallback: {
            alpha: Math.round(globalAlpha * 1000) / 1000,
            beta: Math.round(globalBeta * 1000) / 1000,
            rate: Math.round(globalRate * 10000) / 10000,
          },
          by_category: Object.fromEntries(
            [...categoryPriors.entries()]
              .filter(([, v]) => !v.fallback)
              .map(([k, v]) => [k, {
                alpha: Math.round(v.alpha * 1000) / 1000,
                beta: Math.round(v.beta * 1000) / 1000,
                rate: Math.round(v.rate * 10000) / 10000,
              }])
          ),
          fallback_categories: fallbackCategories,
        },
      };

      const maxFeeds = params.limit ?? 100;
      const truncated = feeds.length > maxFeeds;
      const returnedFeeds = feeds.slice(0, maxFeeds);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              summary,
              feeds: returnedFeeds,
              ...(truncated ? { truncated: true, showing: `${maxFeeds} of ${feeds.length}` } : {}),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_rate_limit_status",
    "Check current API rate limit usage and remaining budget. Costs 0 requests (uses cached response headers).",
    {},
    async () => {
      const state = getState();

      const format = (zone: typeof state.zone1, name: string) => {
        const remaining = zone.limit > 0 ? zone.limit - zone.usage : "unknown";
        const resetMin = Math.ceil(zone.resetAfterSec / 60);
        const lastUpdated = zone.lastUpdated
          ? new Date(zone.lastUpdated).toISOString()
          : "never";
        return {
          zone: name,
          used: zone.usage,
          limit: zone.limit || "unknown",
          remaining,
          reset_in_minutes: resetMin,
          last_updated: lastUpdated,
        };
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                zone1_reads: format(state.zone1, "reads"),
                zone2_writes: format(state.zone2, "writes"),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_user_info",
    "Get current authenticated user information. Costs 1 Zone 1 request.",
    {},
    async () => {
      const data = await apiGet<UserInfoResponse>("/reader/api/0/user-info");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                user_id: data.userId,
                user_name: data.userName,
                email: data.userEmail,
                signup_date: new Date(
                  data.signupTimeSec * 1000
                ).toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
