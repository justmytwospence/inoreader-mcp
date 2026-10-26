import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import { assertBudget } from "../rate-limit.js";
import { ArticleIdsResultSchema, DateInput, jsonResult, SavedItemsResultSchema } from "../contracts.js";
import type {
  UnreadCountResponse,
  StreamContentsResponse,
  StreamItemIdsResponse,
  StreamItemContentsResponse,
  ArticleItem,
} from "../types.js";

function formatArticle(item: ArticleItem) {
  const url =
    item.canonical?.[0]?.href ?? item.alternate?.[0]?.href ?? "";
  const isRead = item.categories.some((c) =>
    c.includes("state/com.google/read")
  );
  const isStarred = item.categories.some((c) =>
    c.includes("state/com.google/starred")
  );
  const isKept = item.categories.some((c) => c.endsWith("/label/Keep"));
  const summary = item.summary?.content
    ? item.summary.content.replace(/<[^>]*>/g, "").slice(0, 300)
    : "";

  return {
    id: item.id,
    title: item.title,
    url,
    author: item.author ?? "",
    published: new Date(item.published * 1000).toISOString(),
    source: item.origin?.title ?? "",
    source_url: item.origin?.htmlUrl ?? "",
    is_read: isRead,
    is_starred: isStarred,
    is_kept: isKept,
    summary,
  };
}

function formatArticleCompact(item: ArticleItem) {
  const isStarred = item.categories.some((c) =>
    c.includes("state/com.google/starred")
  );
  const isKept = item.categories.some((c) => c.endsWith("/label/Keep"));
  const isSavedWebPage = item.categories.some((c) =>
    c.includes("state/com.google/saved-web-page")
  );

  return {
    id: item.id,
    title: item.title,
    source: item.origin?.title ?? "",
    is_starred: isStarred,
    is_kept: isKept,
    is_saved_web_page: isSavedWebPage,
  };
}

export function registerReadingTools(server: McpServer): void {
  server.registerTool("get_unread_counts", { title: "Get unread counts", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Get unread article counts for all feeds and folders, sorted by count descending. Use this first to understand what needs attention. Costs 1 Zone 1 request. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({}) }, async () => {
              const data = await apiGet<UnreadCountResponse>(
                "/reader/api/0/unread-count",
                { output: "json" }
              );

              const counts = data.unreadcounts
                .filter((c) => c.count > 0)
                .sort((a, b) => b.count - a.count)
                .map((c) => ({
                  id: c.id,
                  count: c.count,
                  newest_item: new Date(
                    parseInt(c.newestItemTimestampUsec) / 1000
                  ).toISOString(),
                }));

              return jsonResult(counts);
            });

  server.registerTool("get_articles", { title: "Get articles", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Fetch articles from a feed, folder, tag, or all items. Supports filtering by read/unread/starred status and date range. Costs 1 Zone 1 request per page plus 1 for total_count (disable with include_total=false). total_count is one IDs page of at most 10000; check total_count_is_exact and total_count_continuation before claiming a full total. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({
              stream_id: z
                .string()
                .optional()
                .describe(
                  'Stream ID: feed URL (feed/http://...), folder (user/-/label/Name), system stream (user/-/state/com.google/starred), or saved web pages (user/-/state/com.google/saved-web-pages). Defaults to all items.'
                ),
              count: z
                .number().int()
                .min(1)
                .max(100)
                .optional()
                .describe("Number of articles to fetch (1-100, default 20)"),
              order: z
                .enum(["newest", "oldest"])
                .optional()
                .describe("Sort order (default: newest)"),
              filter: z
                .enum(["all", "unread", "starred"])
                .optional()
                .describe("Filter articles by status"),
              since: DateInput
                .optional()
                .describe("ISO date string - only return articles published after this date"),
              continuation: z
                .string()
                .optional()
                .describe("Continuation token for pagination (from previous response)"),
              compact: z
                .boolean()
                .optional()
                .describe("Return compact metadata (default false). Use for triage workflows to avoid large responses."),
              include_total: z
                .boolean()
                .optional()
                .describe("Include total_count of all matching items across pages (default true). Set false to save 1 Zone 1 request."),
            }) }, async (params) => {
              const streamId = params.stream_id ?? "user/-/state/com.google/reading-list";
              const queryParams: Record<string, string> = {
                output: "json",
                n: String(params.count ?? 20),
              };

              if (params.order === "oldest") queryParams.r = "o";
              if (params.continuation) queryParams.c = params.continuation;
              if (params.since) {
                queryParams.ot = String(Math.floor(new Date(params.since).getTime() / 1000));
              }

              if (params.filter === "unread") {
                queryParams.xt = "user/-/state/com.google/read";
              } else if (params.filter === "starred") {
                queryParams.it = "user/-/state/com.google/starred";
              }

              const includeTotal = params.include_total !== false;
              assertBudget(1, includeTotal ? 2 : 1, "get_articles");
              const totalCountParams: Record<string, string> = {
                output: "json",
                n: "10000",
                s: streamId,
              };
              if (queryParams.xt) totalCountParams.xt = queryParams.xt;
              if (queryParams.it) totalCountParams.it = queryParams.it;
              if (queryParams.ot) totalCountParams.ot = queryParams.ot;

              const [data, idsData] = await Promise.all([
                apiGet<StreamContentsResponse>(
                  `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}`,
                  queryParams
                ),
                includeTotal
                  ? apiGet<StreamItemIdsResponse>("/reader/api/0/stream/items/ids", totalCountParams)
                  : Promise.resolve(null),
              ]);

              const formatter: (item: ArticleItem) => Record<string, unknown> = params.compact ? formatArticleCompact : formatArticle;
              const items = data.items ?? [];
              const result: Record<string, unknown> = {
                articles: items.map(formatter),
                continuation: data.continuation ?? null,
                total_returned: items.length,
              };
              if (idsData !== null) {
                result.total_count = (idsData.itemRefs ?? []).length;
                result.total_count_is_exact = !idsData.continuation;
                result.total_count_continuation = idsData.continuation ?? null;
              }

              return jsonResult(result);
            });

  server.registerTool("get_article_ids", { title: "Get article IDs", outputSchema: ArticleIdsResultSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Lightweight fetch of article IDs from a stream without full content. Useful for counting or batch operations. For a middle ground with titles, use get_articles with compact=true instead. Costs 1 Zone 1 request. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({
              stream_id: z
                .string()
                .optional()
                .describe("Stream ID (defaults to all items)"),
              count: z
                .number().int()
                .min(1)
                .max(10000)
                .optional()
                .describe("Number of IDs to fetch (default 1000, max 10000)"),
              filter: z
                .enum(["all", "unread", "starred"])
                .optional()
                .describe("Filter by status"),
              since: DateInput
                .optional()
                .describe("ISO date - only items after this date"),
              continuation: z
                .string()
                .optional()
                .describe("Continuation token for pagination"),
            }) }, async (params) => {
              const streamId = params.stream_id ?? "user/-/state/com.google/reading-list";
              const queryParams: Record<string, string> = {
                output: "json",
                n: String(params.count ?? 1000),
                s: streamId,
              };

              if (params.continuation) queryParams.c = params.continuation;
              if (params.since) {
                queryParams.ot = String(Math.floor(new Date(params.since).getTime() / 1000));
              }
              if (params.filter === "unread") {
                queryParams.xt = "user/-/state/com.google/read";
              } else if (params.filter === "starred") {
                queryParams.it = "user/-/state/com.google/starred";
              }

              const data = await apiGet<StreamItemIdsResponse>(
                "/reader/api/0/stream/items/ids",
                queryParams
              );

              const itemRefs = data.itemRefs ?? [];
              return jsonResult(ArticleIdsResultSchema.parse({
                ids: itemRefs.map((r) => r.id),
                count: itemRefs.length,
                continuation: data.continuation ?? null,
              }));
            });

  server.registerTool("search_articles", { title: "Search articles", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Search for articles by keyword across all feeds. Costs 1 Zone 1 request per page. Uses undocumented but stable search endpoint. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({
              query: z.string().min(1).max(8192).describe("Search query string"),
              count: z
                .number().int()
                .min(1)
                .max(100)
                .optional()
                .describe("Number of results to return (1-100, default 20)"),
              since: DateInput
                .optional()
                .describe("ISO date string - only return articles published after this date"),
              continuation: z
                .string()
                .optional()
                .describe("Continuation token for pagination (from previous response)"),
              compact: z
                .boolean()
                .optional()
                .describe("Return only id, title, source, is_starred, is_kept (default false)."),
            }) }, async (params) => {
              const queryParams: Record<string, string> = {
                output: "json",
                n: String(params.count ?? 20),
                q: params.query,
              };

              if (params.continuation) queryParams.c = params.continuation;
              if (params.since) {
                queryParams.ot = String(
                  Math.floor(new Date(params.since).getTime() / 1000)
                );
              }

              const data = await apiGet<StreamContentsResponse>(
                "/reader/api/0/stream/contents/user/-/state/com.google/search",
                queryParams
              );

              const formatter: (item: ArticleItem) => Record<string, unknown> = params.compact ? formatArticleCompact : formatArticle;
              const items = data.items ?? [];
              const result = {
                articles: items.map(formatter),
                continuation: data.continuation ?? null,
                total_returned: items.length,
              };

              return jsonResult(result);
            });

  server.registerTool("get_saved_web_pages", { title: "Get saved web pages", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "List saved web pages (manually saved URLs, not from RSS feeds). Supports filtering to find cleanup candidates. Pages can be protected from cleanup by starring or tagging with 'Keep' (via manage_tags add_tag='Keep'). Use filter 'removable' to find pages that are neither starred nor kept -- candidates for review, not authorization to remove. Both count_only and listing apply the filter server-side via the Inoreader API. Set count_only=true to count one filtered IDs page (up to 10000 IDs, with continuation and total_is_exact; not necessarily a collection total) without content (1 Z1 request). Costs 1 Z1 request per page otherwise. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({
              filter: z
                .enum(["all", "starred", "unstarred", "removable"])
                .optional()
                .describe("Filter pages (default: all). 'removable' returns pages that are neither starred nor tagged 'Keep' -- the best filter for cleanup. 'unstarred' excludes starred only. The filter is applied server-side and respected by count_only."),
              count: z
                .number().int()
                .min(1)
                .max(100)
                .optional()
                .describe("Number of pages to fetch (1-100, default 100)"),
              count_only: z
                .boolean()
                .optional()
                .describe("Count one filtered IDs page, not page details (default false). Check total_is_exact and continuation; at most 10000 IDs per call."),
              continuation: z
                .string()
                .optional()
                .describe("Continuation token for pagination"),
              compact: z
                .boolean()
                .optional()
                .describe("Return only id, title, source, is_starred, is_kept (default false)."),
            }) }, async (params) => {
              const streamId = "user/-/state/com.google/saved-web-pages";
              const starredStream = "user/-/state/com.google/starred";
              const keepStream = "user/-/label/Keep";

              const filterParams: Record<string, string | string[]> = {};
              if (params.filter === "starred") {
                filterParams.it = starredStream;
              } else if (params.filter === "unstarred") {
                filterParams.xt = starredStream;
              } else if (params.filter === "removable") {
                filterParams.xt = [starredStream, keepStream];
              }

              if (params.count_only) {
                const data = await apiGet<StreamItemIdsResponse>(
                  "/reader/api/0/stream/items/ids",
                  { s: streamId, n: "10000", output: "json", ...filterParams, ...(params.continuation ? { c: params.continuation } : {}) }
                );
                return jsonResult({ total: (data.itemRefs ?? []).length, total_is_exact: !params.continuation && !data.continuation, continuation: data.continuation ?? null, note: "Count for this IDs page only (max 10000), not necessarily the collection total." });
              }

              const queryParams: Record<string, string | string[]> = {
                output: "json",
                n: String(params.count ?? 100),
                ...filterParams,
              };

              if (params.continuation) queryParams.c = params.continuation;

              const data = await apiGet<StreamContentsResponse>(
                `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}`,
                queryParams
              );

              const formatter: (item: ArticleItem) => Record<string, unknown> = params.compact ? formatArticleCompact : formatArticle;
              const pages = (data.items ?? []).map(formatter);

              const result = {
                pages,
                continuation: data.continuation ?? null,
                total_returned: pages.length,
              };

              return jsonResult(result);
            });

  server.registerTool("get_saved_items", { title: "Get saved items", outputSchema: SavedItemsResultSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Get a bounded union of starred articles, saved web pages, and Keep-tagged items, deduplicated with saved_via membership from the fetched pages. Reads up to max_pages_per_collection (default 1, max 10) pages of 100 per collection: 3-30 Zone 1 requests before read retries. total_count is the fetched union, NOT an account-wide total unless complete=true; continuations and per-collection errors disclose partial coverage. Resume individual streams with get_articles. Preflights the maximum base cost against known remaining quota; unknown quota is not assumed unlimited. See inoreader://usage for budgets, template examples and prompts.", inputSchema: z.object({
    compact: z.boolean().optional().describe("Compact metadata (default true)."),
    max_pages_per_collection: z.number().int().min(1).max(10).optional().describe("Maximum 100-item pages per collection (default 1). Total base cost is at most 3 times this bound."),
  }) }, async (params) => {
    const maxPages = params.max_pages_per_collection ?? 1;
    assertBudget(1, 3 * maxPages, "get_saved_items");
    const definitions = [
      { name: "starred", stream: "user/-/state/com.google/reading-list", it: "user/-/state/com.google/starred", via: "starred" },
      { name: "saved_web_pages", stream: "user/-/state/com.google/saved-web-pages", via: "saved_web_page" },
      { name: "keep", stream: "user/-/label/Keep", via: "keep" },
    ] as const;
    const collections: Record<string, { stream_id: string; filter: "all" | "starred"; pages: number; count: number; continuation: string | null; error: string | null }> = {};
    const union = new Map<string, { item: ArticleItem; via: string[] }>();
    await Promise.all(definitions.map(async (def) => {
      const state = { stream_id: def.stream, filter: "it" in def ? "starred" as const : "all" as const, pages: 0, count: 0, continuation: null as string | null, error: null as string | null };
      collections[def.name] = state;
      const ids = new Set<string>();
      try {
        do {
          assertBudget(1, 1, "get_saved_items page");
          const data = await apiGet<StreamContentsResponse>(
            `/reader/api/0/stream/contents/${encodeURIComponent(def.stream)}`,
            { output: "json", n: "100", ...("it" in def ? { it: def.it } : {}),
              ...(state.continuation ? { c: state.continuation } : {}) },
          );
          state.pages++;
          if ((data.items ?? []).length > 100) state.error = "Upstream ignored the 100-item page bound; returned content was capped, coverage is incomplete.";
          for (const item of (data.items ?? []).slice(0, 100)) {
            ids.add(item.id);
            const saved = union.get(item.id);
            if (saved) {
              if (!saved.via.includes(def.via)) saved.via.push(def.via);
            } else union.set(item.id, { item, via: [def.via] });
          }
          state.continuation = data.continuation ?? null;
        } while (state.continuation && state.pages < maxPages && !state.error);
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      state.count = ids.size;
    }));
    const formatter = params.compact !== false ? formatArticleCompact : formatArticle;
    const result = SavedItemsResultSchema.parse({
      items: [...union.values()].sort((a,b) => b.item.published - a.item.published).map(({item,via}) => ({
        ...formatter(item), saved_via: via.sort(),
      })),
      total_count: union.size,
      by_collection: Object.fromEntries(Object.entries(collections).map(([name,state]) => [name,state.count])),
      complete: Object.values(collections).every((s) => !s.continuation && !s.error),
      collections,
      ...(Object.values(collections).some((s) => !!s.error)
        ? { unavailable_collections: definitions.filter((d) => collections[d.name].error).map((d) => d.stream) } : {}),
      note: "Counts and saved_via describe fetched pages only; a missing label, HTTP failure, or page cap makes coverage partial. Use get_articles with each collection's stream_id, filter and continuation to resume. Base request costs exclude safe-read retries.",
    });
    return jsonResult(result, Object.values(collections).some((s) => !!s.error));
  });

  server.registerTool("get_article_content", { title: "Get article content", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "Get full HTML content for specific articles by ID. Use after get_articles or search_articles to read full content. Costs 1 Zone 1 request. Base costs exclude safe-read retries (up to 4 attempts, each counted); honor cached status/cooldown. Never blindly replay uncertain writes. See inoreader://usage for limits, URI examples and prompts.", inputSchema: z.object({
              article_ids: z
                .array(z.string().min(1).max(8192))
                .min(1)
                .max(20)
                .describe("Article IDs to fetch full content for (max 20)"),
            }) }, async (params) => {
              const searchParams = new URLSearchParams();
              for (const id of params.article_ids) {
                searchParams.append("i", id);
              }

              const data = await apiPost<StreamItemContentsResponse>(
                "/reader/api/0/stream/items/contents",
                searchParams
              );

              const articles = (data.items ?? []).map((item) => {
                const url =
                  item.canonical?.[0]?.href ?? item.alternate?.[0]?.href ?? "";
                return {
                  id: item.id,
                  title: item.title,
                  url,
                  author: item.author ?? "",
                  published: new Date(item.published * 1000).toISOString(),
                  source: item.origin?.title ?? "",
                  content: item.summary?.content ?? "",
                };
              });

              return jsonResult(articles);
            });
}
