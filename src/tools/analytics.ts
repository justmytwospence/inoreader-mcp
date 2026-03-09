import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, invalidateCache } from "../api.js";
import { getState } from "../rate-limit.js";
import type {
  SubscriptionListResponse,
  UnreadCountResponse,
  StreamContentsResponse,
  StreamItemIdsResponse,
  UserInfoResponse,
} from "../types.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.tool(
    "analyze_feeds",
    "Analyze feed health and engagement using a Beta-Binomial Bayesian model. Computes engagement_rate as the posterior mean of saved/total per feed, with an empirical Bayes prior estimated from the global save rate. This shrinks small-sample feeds toward the global mean, preventing feeds with 1/1 saves from dominating. Also provides credible_lower (90% credible interval lower bound) for conservative ranking. Results are cached for 1 hour. Costs 2 + starred_pages + engaged_feed_count Zone 1 requests on first call, 0 on subsequent cached calls.",
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
        .enum(["engagement_rate", "credible_lower", "saved_count", "title", "days_since_newest"])
        .optional()
        .describe("Sort results by (default: engagement_rate). Use credible_lower for conservative ranking that penalizes small samples more."),
      prior_strength: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Beta prior pseudo-observation count (default 10). Higher values shrink small-sample feeds more aggressively toward the global mean."),
      starred_pages: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max pages of saved/starred articles to fetch (100 per page, default 10). More pages = better engagement data but higher API cost."),
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

      // Fetch subscriptions and unread counts in parallel (2 Z1)
      const [subData, unreadData] = await Promise.all([
        apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", {
          output: "json",
        }),
        apiGet<UnreadCountResponse>("/reader/api/0/unread-count", {
          output: "json",
        }),
      ]);

      // Fetch saved/starred articles within the time window to build engagement map
      const savedCountByFeed = new Map<string, number>();
      const maxPages = params.starred_pages ?? 10;
      let continuation: string | undefined;
      let totalSaved = 0;
      let z1Cost = 2; // subscriptions + unread counts

      for (let page = 0; page < maxPages; page++) {
        const queryParams: Record<string, string> = {
          output: "json",
          n: "100",
          ot: sinceTimestamp,
        };
        if (continuation) queryParams.c = continuation;

        const saved = await apiGet<StreamContentsResponse>(
          `/reader/api/0/stream/contents/${encodeURIComponent("user/-/state/com.google/starred")}`,
          queryParams
        );
        z1Cost++;

        for (const item of saved.items) {
          const feedId = item.origin?.streamId;
          if (feedId) {
            savedCountByFeed.set(feedId, (savedCountByFeed.get(feedId) ?? 0) + 1);
          }
        }
        totalSaved += saved.items.length;

        if (!saved.continuation) break;
        continuation = saved.continuation;
      }

      // For feeds with engagement, fetch total article count in the same window
      const totalArticlesByFeed = new Map<string, number>();
      const engagedFeedIds = [...savedCountByFeed.keys()];

      const sinceTimestampUsec = BigInt(sinceTimestamp) * 1_000_000n;

      await Promise.all(
        engagedFeedIds.map(async (feedId) => {
          try {
            const data = await apiGet<StreamItemIdsResponse>(
              "/reader/api/0/stream/items/ids",
              {
                s: feedId,
                ot: sinceTimestamp,
                n: "10000",
                output: "json",
              }
            );
            z1Cost++;
            // Filter by published timestamp to exclude backfilled articles
            // from before the window (newly subscribed feeds import old items
            // with recent crawl times, so the API's ot filter doesn't catch them)
            const inWindow = data.itemRefs.filter(
              (ref) => BigInt(ref.timestampUsec) >= sinceTimestampUsec
            );
            totalArticlesByFeed.set(feedId, inWindow.length);
          } catch {
            // Some feed IDs from starred articles may no longer be valid
          }
        })
      );

      const unreadMap = new Map(
        unreadData.unreadcounts.map((c) => [
          c.id,
          {
            count: c.count,
            newestItemTimestamp: parseInt(c.newestItemTimestampUsec) / 1000,
          },
        ])
      );

      // Compute empirical Bayes Beta prior from all engaged feeds
      const priorStrength = params.prior_strength ?? 10;
      let globalSaved = 0;
      let globalTotal = 0;
      for (const feedId of engagedFeedIds) {
        const total = totalArticlesByFeed.get(feedId);
        if (total !== undefined) {
          globalSaved += savedCountByFeed.get(feedId) ?? 0;
          globalTotal += total;
        }
      }
      const globalRate = globalTotal > 0 ? globalSaved / globalTotal : 0;
      const alpha = globalRate * priorStrength;
      const beta = (1 - globalRate) * priorStrength;

      let feeds = subData.subscriptions.map((sub) => {
        const unread = unreadMap.get(sub.id);
        const newestItemDate = unread?.newestItemTimestamp
          ? new Date(unread.newestItemTimestamp).toISOString()
          : null;
        const daysSinceNewest = unread?.newestItemTimestamp
          ? (Date.now() - unread.newestItemTimestamp) / (1000 * 60 * 60 * 24)
          : null;
        const savedCount = savedCountByFeed.get(sub.id) ?? 0;
        const totalArticles = totalArticlesByFeed.get(sub.id) ?? null;

        // Beta-Binomial posterior mean
        let engagementRate: number | null;
        let credibleLower: number | null;
        if (savedCount > 0 && totalArticles !== null && totalArticles > 0) {
          const n = totalArticles;
          const posteriorAlpha = alpha + savedCount;
          const posteriorBeta = beta + n - savedCount;
          const posteriorN = posteriorAlpha + posteriorBeta;
          engagementRate = posteriorAlpha / posteriorN;
          // Normal approximation to 90% credible interval lower bound
          const variance = (posteriorAlpha * posteriorBeta) / (posteriorN * posteriorN * (posteriorN + 1));
          credibleLower = Math.max(0, engagementRate - 1.645 * Math.sqrt(variance));
        } else if (savedCount > 0) {
          // Saved articles exist but total count fetch failed
          engagementRate = null;
          credibleLower = null;
        } else {
          engagementRate = 0;
          credibleLower = 0;
        }

        let status: "high-engagement" | "moderate-engagement" | "never-engaged" | "dormant";
        if (daysSinceNewest !== null && daysSinceNewest > 90) {
          status = "dormant";
        } else if (engagementRate !== null && engagementRate > 0.1) {
          status = "high-engagement";
        } else if (savedCount > 0) {
          status = "moderate-engagement";
        } else {
          status = "never-engaged";
        }

        return {
          title: sub.title,
          id: sub.id,
          folders: sub.categories.map((c) => c.label),
          saved_count: savedCount,
          total_articles: totalArticles,
          engagement_rate: engagementRate !== null ? Math.round(engagementRate * 10000) / 10000 : null,
          credible_lower: credibleLower !== null ? Math.round(credibleLower * 10000) / 10000 : null,
          newest_item_date: newestItemDate,
          days_since_newest: daysSinceNewest ? Math.round(daysSinceNewest) : null,
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

      const sortBy = params.sort_by ?? "engagement_rate";
      if (sortBy === "engagement_rate") {
        feeds.sort((a, b) => (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1));
      } else if (sortBy === "credible_lower") {
        feeds.sort((a, b) => (b.credible_lower ?? -1) - (a.credible_lower ?? -1));
      } else if (sortBy === "saved_count") {
        feeds.sort((a, b) => b.saved_count - a.saved_count);
      } else if (sortBy === "days_since_newest") {
        feeds.sort((a, b) => (b.days_since_newest ?? 9999) - (a.days_since_newest ?? 9999));
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
        saved_articles_scanned: totalSaved,
        has_more_saved: continuation !== undefined,
        api_cost_z1: z1Cost,
        prior: {
          alpha: Math.round(alpha * 1000) / 1000,
          beta: Math.round(beta * 1000) / 1000,
          global_rate: Math.round(globalRate * 10000) / 10000,
          strength: priorStrength,
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
