import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet } from "../api.js";
import { assertBudget, snapshot, zoneRemaining } from "../rate-limit.js";
import { jsonResult } from "../contracts.js";
import { countEngagement, fitCategoryPriors, feedPosterior, type FeedCounts } from "../feed-analysis.js";
import { normalizeTagId } from "../verify-tags.js";
import { labelType } from "../labels.js";
import type {
  ArticleItem,
  SubscriptionListResponse,
  UnreadCountResponse,
  StreamContentsResponse,
  StreamItemIdsResponse,
  TagListResponse,
  UserInfoResponse,
} from "../types.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool("analyze_feeds", { title: "Analyze feeds", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Analyze feed health and explicit engagement with a category-pooled Beta-Binomial model (default 12 months, prior strength 10). By default counts starred, liked, broadcast and custom tags, excluding folders and passive system states; engagement_streams selects an explicit positive allowlist. Ordinary read flags are not engagement. Articles are deduplicated across positive streams. Categories with fewer than two engaged feeds use the global prior; multiple actual topic priors are averaged, excluding exclude_topic_folders. Reports exact equal-tailed 90% Beta bounds and posterior shapes only for complete, consistent counts. Missing, capped or failed coverage is unknown, not zero engagement. Retained engagement can exceed retained feed volume: this is flagged without silently flooring the denominator. Historical rates are retention/subscription-affected context, never authorization for automatic actions. Engagement and volume follow continuations within max_requests and the known 25-read reserve. Default sort unengaged_per_month estimates wasted posting volume; skipped sorts ascending by total minus engaged. Sorting engaged_count, title or days_since_newest skips engaged-feed volume reads; volume_sample optionally counts never-engaged active feeds. Costs 3 metadata reads plus engagement pages and optional volume pages EVERY call; no caching. max_requests counts base calls including failed calls; safe-read retries are extra (up to 4 attempts, counted in rate-limit status). Check get_rate_limit_status before large scans. See inoreader://usage for limits and URI examples.", inputSchema: z.object({
              max_requests: z.number().int().min(3).max(500).optional().describe("Maximum base Zone 1 calls across this workflow (default 100); retries are extra. Leaves 25 known requests in reserve and reports partial coverage."),
              engagement_streams: z.array(z.string().min(1)).optional().describe("Explicit positive stream IDs. Only these streams count as engagement; omit to retain the default explicit-action/custom-tag policy. Do not include negative or automation labels."),
              exclude_topic_folders: z.array(z.string()).optional().describe("Folder names or IDs excluded from category pooling (for example an operational priority folder); memberships are preserved."),
              folder: z
                .string()
                .optional()
                .describe("Limit analysis to feeds in this folder"),
              months: z
                .number()
                .min(1)
                .max(24)
                .optional()
                .describe("Time window in months to analyze (default 12)"),
              sort_by: z
                .enum(["engagement_rate", "credible_lower", "engaged_count", "skipped", "title", "days_since_newest", "unengaged_per_month"])
                .optional()
                .describe("Sort results by (default: unengaged_per_month). skipped sorts ascending by total - engaged to find feeds you read almost everything from (Must Read candidates). unengaged_per_month ranks by estimated wasted articles per month to surface pruning candidates. Use credible_lower for conservative ranking that penalizes small samples more."),
              prior_strength: z
                .number()
                .min(1)
                .max(100)
                .optional()
                .describe("Beta prior pseudo-observation count (default 10). Higher values shrink small-sample feeds more aggressively toward the global mean."),
              engagement_pages: z
                .number().int()
                .min(1)
                .max(500)
                .optional()
                .describe("Per-tag safety cap on engagement pages (100 items per page, default 100). Pagination normally ends naturally when the ot time filter is exhausted; this cap only binds for users with thousands of engaged items per tag in the window."),
              volume_sample: z
                .number().int()
                .min(0)
                .max(200)
                .optional()
                .describe("How many never-engaged active feeds to also count volume for, to rank noise (default 0). Set higher to find the noisiest unengaged feeds, at 1 extra API call each."),
              limit: z
                .number().int()
                .min(1)
                .max(500)
                .optional()
                .describe("Max number of feeds to return (default 100). Use to keep response size manageable."),
              refresh: z
                .boolean()
                .optional()
                .describe("No-op, retained for compatibility. Reads are not cached between calls."),
            }) }, async (params) => {

              assertBudget(1, 3, "analyze_feeds initial reads", 25);
              const maxRequests = params.max_requests ?? 100;
              const degraded: string[] = [];
              const monthsBack = params.months ?? 12;
              const globalSinceSec = Math.floor(
                (Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000) / 1000
              );
              const sinceTimestamp = String(globalSinceSec);

              // Fetch subscriptions, unread counts, and tags in parallel (3 Z1)
              const [subData, unreadData, tagData] = await Promise.all([
                apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", {
                  output: "json",
                }, { reserve: 25 }),
                apiGet<UnreadCountResponse>("/reader/api/0/unread-count", {
                  output: "json",
                }, { reserve: 25 }),
                apiGet<TagListResponse>("/reader/api/0/tag/list", {
                  output: "json", types: "1",
                }, { reserve: 25 }),
              ]);

              // Determine which tags represent engagement (not folders or passive states)
              const folderIds = new Set<string>();
              for (const sub of subData.subscriptions) {
                for (const cat of sub.categories) {
                  folderIds.add(cat.id);
                }
              }
              const isPassive = (id: string) => id.includes("/state/com.google/") &&
                !["starred", "like", "liked", "broadcast"].some((state) => id.endsWith("/state/com.google/" + state));
              const normalizedFolders = new Set([...folderIds].map(normalizeTagId));
              for (const tag of tagData.tags) {
                if (tag.type === "folder") normalizedFolders.add(normalizeTagId(tag.id));
              }
              const availableTags = new Map(tagData.tags.map((tag) => [normalizeTagId(tag.id), tag]));
              const unknownLabels = params.engagement_streams === undefined
                ? tagData.tags.filter((tag) => labelType({ ...tag, id: normalizeTagId(tag.id) }, normalizedFolders) === "unknown") : [];
              if (unknownLabels.length > 0) degraded.push("Unclassified labels were not trusted as positive streams; missing labels are NOT evidence of no engagement. Supply engagement_streams or authoritative tag types.");
              const requestedStreams = params.engagement_streams ?? tagData.tags
                .filter((tag) => ["tag", "state"].includes(labelType({ ...tag, id: normalizeTagId(tag.id) }, normalizedFolders)))
                .map((tag) => tag.id);
              const engagementTagIds = [...new Map(requestedStreams
                .filter((id) => {
                  const normalized = normalizeTagId(id);
                  const tag = availableTags.get(normalized);
                  return !normalizedFolders.has(normalized) && !isPassive(id) &&
                    (tag?.type === undefined || tag.type === "tag");
                })
                .map((id) => [normalizeTagId(id), id])).values()];

              // A shared deduplicator sees every positive stream's in-window articles.
              const engagedItems: ArticleItem[] = [];
              const perTagPageCap = params.engagement_pages ?? 100;
              let pagesUsed = 0;
              let safetyCapHit = unknownLabels.length > 0;
              let z1Cost = 3; // subscriptions + unread counts + tag list
              const canRead = () => {
                const remaining = zoneRemaining(1).remaining;
                return z1Cost < maxRequests && (remaining === null || remaining > 25);
              };

              engagement: for (const tagId of engagementTagIds) {
                let continuation: string | undefined;
                const seenCursors = new Set<string>();
                let tagComplete = false;
                for (let page = 0; page < perTagPageCap; page++) {
                  if (!canRead()) {
                    degraded.push("Engagement scan stopped at workflow/known quota budget; unscanned tags are NOT evidence of no engagement.");
                    safetyCapHit = true;
                    break engagement;
                  }
                  const queryParams: Record<string, string> = { output: "json", n: "100", ot: sinceTimestamp, r: "d" };
                  if (continuation) queryParams.c = continuation;
                  let data: StreamContentsResponse;
                  z1Cost++;
                  try {
                    data = await apiGet<StreamContentsResponse>(
                      `/reader/api/0/stream/contents/${encodeURIComponent(tagId)}`,
                      queryParams, { reserve: 25 }
                    );
                  } catch (e) {
                    degraded.push(`Engagement stream ${tagId} failed: ${String(e)}`);
                    safetyCapHit = true;
                    break;
                  }
                  pagesUsed++;
                  let reachedWindowEdge = false;
                  for (const item of data.items) {
                    const itemSec = parseInt(item.timestampUsec ?? "0", 10) / 1_000_000;
                    if (itemSec > 0 && itemSec < globalSinceSec) { reachedWindowEdge = true; continue; }
                    engagedItems.push(item);
                  }
                  if (reachedWindowEdge || !data.continuation) { tagComplete = true; break; }
                  if (seenCursors.has(data.continuation)) {
                    degraded.push(`Engagement stream ${tagId} repeated a continuation; coverage is incomplete.`);
                    break;
                  }
                  continuation = data.continuation;
                  seenCursors.add(continuation);
                }
                if (!tagComplete) safetyCapHit = true;
              }
              const engagementComplete = !safetyCapHit;
              const engagedCountByFeed = countEngagement(engagedItems);
              const totalEngaged = [...engagedCountByFeed.values()].reduce((sum, count) => sum + count, 0);

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

              // A page length is not a total. Retain observed counts, but only
              // declare a denominator complete after exhausting its continuation.
              const totalArticlesByFeed = new Map<string, number>();
              const volumeCompleteByFeed = new Map<string, boolean>();
              async function countFeedArticles(feedId: string): Promise<void> {
                const ids = new Set<string>();
                const cursors = new Set<string>();
                let continuation: string | undefined;
                volumeCompleteByFeed.set(feedId, false);
                while (canRead()) {
                  try {
                    assertBudget(1, 1, "analyze_feeds volume", 25);
                    const query: Record<string, string> = { s: feedId, ot: sinceTimestamp, n: "10000", output: "json" };
                    if (continuation) query.c = continuation;
                    z1Cost++;
                    const data = await apiGet<StreamItemIdsResponse>("/reader/api/0/stream/items/ids", query, { reserve: 25 });
                    if (!Array.isArray(data.itemRefs)) throw new Error("Missing itemRefs; denominator unknown");
                    for (const item of data.itemRefs) ids.add(item.id);
                    totalArticlesByFeed.set(feedId, ids.size);
                    if (!data.continuation) { volumeCompleteByFeed.set(feedId, true); return; }
                    if (cursors.has(data.continuation)) throw new Error("Repeated volume continuation");
                    continuation = data.continuation;
                    cursors.add(continuation);
                  } catch (e) {
                    degraded.push(`Volume unavailable/incomplete for ${feedId}: ${String(e)}`);
                    return;
                  }
                }
                degraded.push(`Volume for ${feedId} incomplete at workflow/known quota budget; observed page lengths are not totals.`);
              }

              const engagedFeedIds = [...engagedCountByFeed.keys()];
              const sortBy = params.sort_by ?? "unengaged_per_month";
              const needsVolume = sortBy !== "engaged_count" && sortBy !== "title" && sortBy !== "days_since_newest";
              // Sequential pagination admits every base call individually and
              // prevents concurrent continuations from overrunning max_requests.
              if (needsVolume) {
                for (const feedId of engagedFeedIds) {
                  if (!canRead()) {
                    degraded.push("Workflow/known quota budget: skipped remaining volume reads; ranking is incomplete.");
                    break;
                  }
                  await countFeedArticles(feedId);
                }
              }

              const volumeSample = params.volume_sample ?? 0;
              if (volumeSample > 0) {
                const now = Date.now();
                const neverEngagedActive = subData.subscriptions
                  .filter((sub) => {
                    if (engagedCountByFeed.has(sub.id)) return false;
                    const newest = unreadMap.get(sub.id)?.newestItemTimestamp;
                    return newest !== undefined && newest > 0 && (now - newest) / 86400000 <= 90;
                  })
                  .sort((a, b) => (unreadMap.get(b.id)?.newestItemTimestamp ?? 0) - (unreadMap.get(a.id)?.newestItemTimestamp ?? 0))
                  .slice(0, volumeSample);
                for (const sub of neverEngagedActive) {
                  if (!canRead()) {
                    degraded.push("Workflow/known quota budget: skipped remaining sampled volume reads.");
                    break;
                  }
                  await countFeedArticles(sub.id);
                }
              }

              const priorStrength = params.prior_strength ?? 10;
              const topicKey = (folder: string) => normalizeTagId(folder).trim().toLowerCase();
              const excludedTopics = new Set((params.exclude_topic_folders ?? []).map(topicKey));
              const topicFolders = (sub: SubscriptionListResponse["subscriptions"][number]) => sub.categories
                .filter((cat) => !excludedTopics.has(topicKey(cat.label)) && !excludedTopics.has(topicKey(cat.id)))
                .map((cat) => cat.label);
              const counts: FeedCounts[] = subData.subscriptions.map((sub) => ({
                stream_id: sub.id,
                folders: topicFolders(sub),
                k: engagedCountByFeed.get(sub.id) ?? 0,
                // Unobserved denominators are flagged incomplete, not admitted to pooling.
                n: totalArticlesByFeed.get(sub.id) ?? 0,
                volume_complete: volumeCompleteByFeed.get(sub.id) === true,
                engagement_complete: engagementComplete,
              }));
              const priorReport = fitCategoryPriors(counts, [], priorStrength);
              const globalAlpha = priorReport.global.alpha;
              const globalBeta = priorReport.global.beta;
              const globalRate = priorReport.global.rate;
              const categoryPriors = new Map(Object.entries(priorReport.by_category));
              const fallbackCategories = priorReport.fallback_categories;
              const feedPriors = new Map(subData.subscriptions.map((sub) => {
                const priors = topicFolders(sub).map((folder) => categoryPriors.get(folder)).filter((p) => p !== undefined);
                return [sub.id, priors.length === 0 ? priorReport.global : {
                  alpha: priors.reduce((sum, p) => sum + p.alpha, 0) / priors.length,
                  beta: priors.reduce((sum, p) => sum + p.beta, 0) / priors.length,
                }];
              }));

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

                const volumeComplete = volumeCompleteByFeed.get(sub.id) === true;
                const retentionAdjusted = totalArticles !== null && engagedCount > totalArticles;
                if (retentionAdjusted) degraded.push(`Retained engagement exceeds observed volume for ${sub.id}; denominator was not floored and no posterior is reported.`);
                const prior = feedPriors.get(sub.id) ?? priorReport.global;
                const posterior = engagementComplete && volumeComplete && totalArticles !== null && !retentionAdjusted
                  ? feedPosterior(engagedCount, totalArticles, prior) : null;
                const engagementRate = posterior?.mean ?? null;
                const credibleLower = posterior?.ci_low ?? null;

                let status: "high-engagement" | "moderate-engagement" | "never-engaged" | "dormant" | "unknown";
                if (daysSinceNewest !== null && daysSinceNewest > 90) {
                  status = "dormant";
                } else if (engagementRate !== null && engagementRate > 0.1) {
                  status = "high-engagement";
                } else if (engagedCount > 0) {
                  status = "moderate-engagement";
                } else {
                  status = engagementComplete ? "never-engaged" : "unknown";
                }

                return {
                  title: sub.title,
                  id: sub.id,
                  folders: sub.categories.map((c) => c.label),
                  engaged_count: engagedCount > 0 || engagementComplete ? engagedCount : null,
                  observed_engaged_count: engagedCount,
                  total_articles: totalArticles,
                  volume_complete: volumeComplete,
                  engagement_complete: engagementComplete,
                  retention_adjusted: retentionAdjusted,
                  posterior_alpha: posterior?.alpha ?? null,
                  posterior_beta: posterior?.beta ?? null,
                  ci_low: posterior?.ci_low ?? null,
                  ci_high: posterior?.ci_high ?? null,
                  credible_upper: posterior?.ci_high ?? null,
                  engagement_rate: engagementRate !== null ? Math.round(engagementRate * 10000) / 10000 : null,
                  credible_lower: credibleLower !== null ? Math.round(credibleLower * 10000) / 10000 : null,
                  newest_item_date: newestItemDate,
                  days_since_newest: daysSinceNewest ? Math.round(daysSinceNewest) : null,
                  skipped: posterior !== null && totalArticles !== null ? totalArticles - engagedCount : null,
                  unengaged_per_month: engagementRate !== null && totalArticles !== null
                    ? Math.round((1 - engagementRate) * totalArticles / monthsBack * 100) / 100
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

              if (sortBy === "engagement_rate") {
                feeds.sort((a, b) => (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1));
              } else if (sortBy === "credible_lower") {
                feeds.sort((a, b) => (b.credible_lower ?? -1) - (a.credible_lower ?? -1));
              } else if (sortBy === "engaged_count") {
                feeds.sort((a, b) => (b.engaged_count ?? -1) - (a.engaged_count ?? -1));
              } else if (sortBy === "skipped") {
                feeds.sort((a, b) => (a.skipped ?? 9999) - (b.skipped ?? 9999));
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
                unknown: feeds.filter((f) => f.status === "unknown").length,
                dormant: feeds.filter((f) => f.status === "dormant").length,
                window_months: monthsBack,
                engaged_articles_scanned: totalEngaged,
                has_more_engaged: safetyCapHit,
                engagement_complete: engagementComplete,
                engagement_pages_used: pagesUsed,
                engagement_tags_used: engagementTagIds.length,
                engagement_tag_ids: engagementTagIds,
                api_cost_z1: z1Cost,
                cost_basis: "Base calls scheduled (including failed calls); safe-read retries are extra and counted in rate-limit status. Not a monetary charge.",
                ...(degraded.length > 0 ? { degraded } : {}),
                volume_feeds_counted: totalArticlesByFeed.size,
                prior: {
                  strength: priorStrength,
                  global_observations: priorReport.global_observations,
                  global_stabilized: priorReport.global_stabilized,
                  stabilized_categories: priorReport.stabilized_categories,
                  global_fallback: { alpha: globalAlpha, beta: globalBeta, rate: globalRate },
                  by_category: Object.fromEntries(
                    [...categoryPriors.entries()]
                      .filter(([category]) => !fallbackCategories.includes(category))
                      .map(([k, v]) => [k, { alpha: v.alpha, beta: v.beta, rate: v.rate }])
                  ),
                  fallback_categories: fallbackCategories,
                },
              };

              const maxFeeds = params.limit ?? 100;
              const truncated = feeds.length > maxFeeds;
              const returnedFeeds = feeds.slice(0, maxFeeds);

              return jsonResult({
                      summary,
                      feeds: returnedFeeds,
                      ...(truncated ? { truncated: true, showing: `${maxFeeds} of ${feeds.length}` } : {}),
                    });
            });

  server.registerTool("get_rate_limit_status", { title: "Get rate limit status", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Check cached quota observations, reset/cooldown times and conservative local estimates. Costs 0 HTTP/auth requests. Header usage is authoritative only at observation time; missing/expired values mean unknown, not free calls. Every attempted API fetch (including retries and failures) is counted locally; other clients/processes are unseen. See inoreader://usage for request costs, URI examples and all workflow prompts.", inputSchema: z.object({}) }, async () => {
              return jsonResult(snapshot());
            });

  server.registerTool("get_user_info", { title: "Get user info", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Get current authenticated user information. Costs 1 Zone 1 request. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({}) }, async () => {
              const data = await apiGet<UserInfoResponse>("/reader/api/0/user-info");

              return jsonResult({
                        user_id: data.userId,
                        user_name: data.userName,
                        email: data.userEmail,
                        signup_date: new Date(
                          data.signupTimeSec * 1000
                        ).toISOString(),
                      });
            });
}
