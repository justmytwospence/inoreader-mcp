import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
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
    summary,
  };
}

export function registerReadingTools(server: McpServer): void {
  server.tool(
    "get_unread_counts",
    "Get unread article counts for all feeds and folders, sorted by count descending. Use this first to understand what needs attention. Costs 1 Zone 1 request.",
    {},
    async () => {
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(counts, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_articles",
    "Fetch articles from a feed, folder, tag, or all items. Supports filtering by read/unread/starred status and date range. Costs 1 Zone 1 request per page (max 100 articles per page).",
    {
      stream_id: z
        .string()
        .optional()
        .describe(
          'Stream ID: feed URL (feed/http://...), folder (user/-/label/Name), system stream (user/-/state/com.google/starred), or saved web pages (user/-/state/com.google/saved-web-pages). Defaults to all items.'
        ),
      count: z
        .number()
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
      since: z
        .string()
        .optional()
        .describe("ISO date string - only return articles published after this date"),
      continuation: z
        .string()
        .optional()
        .describe("Continuation token for pagination (from previous response)"),
    },
    async (params) => {
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

      const data = await apiGet<StreamContentsResponse>(
        `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}`,
        queryParams
      );

      const result = {
        articles: data.items.map(formatArticle),
        continuation: data.continuation ?? null,
        total_returned: data.items.length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_article_ids",
    "Lightweight fetch of article IDs from a stream without full content. Useful for counting or batch operations. Costs 1 Zone 1 request.",
    {
      stream_id: z
        .string()
        .optional()
        .describe("Stream ID (defaults to all items)"),
      count: z
        .number()
        .min(1)
        .max(10000)
        .optional()
        .describe("Number of IDs to fetch (default 1000, max 10000)"),
      filter: z
        .enum(["all", "unread", "starred"])
        .optional()
        .describe("Filter by status"),
      since: z
        .string()
        .optional()
        .describe("ISO date - only items after this date"),
      continuation: z
        .string()
        .optional()
        .describe("Continuation token for pagination"),
    },
    async (params) => {
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ids: data.itemRefs.map((r) => r.id),
                count: data.itemRefs.length,
                continuation: data.continuation ?? null,
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
    "search_articles",
    "Search for articles by keyword across all feeds. Costs 1 Zone 1 request per page. Uses undocumented but stable search endpoint.",
    {
      query: z.string().describe("Search query string"),
      count: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of results to return (1-100, default 20)"),
      since: z
        .string()
        .optional()
        .describe("ISO date string - only return articles published after this date"),
      continuation: z
        .string()
        .optional()
        .describe("Continuation token for pagination (from previous response)"),
    },
    async (params) => {
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

      const result = {
        articles: data.items.map(formatArticle),
        continuation: data.continuation ?? null,
        total_returned: data.items.length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_saved_web_pages",
    "List saved web pages (manually saved URLs, not from RSS feeds). Supports filtering by starred status to find pages that need cleanup. IMPORTANT: Always present unstarred pages to the user for review before removing any -- some may be valuable references or tools worth keeping. Costs 1 Zone 1 request per page.",
    {
      filter: z
        .enum(["all", "starred", "unstarred"])
        .optional()
        .describe("Filter by starred status (default: all). Use 'unstarred' to find cleanup candidates."),
      count: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of pages to fetch (1-100, default 100)"),
      continuation: z
        .string()
        .optional()
        .describe("Continuation token for pagination"),
    },
    async (params) => {
      const queryParams: Record<string, string> = {
        output: "json",
        n: String(params.count ?? 100),
      };

      if (params.continuation) queryParams.c = params.continuation;
      if (params.filter === "unstarred") {
        queryParams.xt = "user/-/state/com.google/starred";
      } else if (params.filter === "starred") {
        queryParams.it = "user/-/state/com.google/starred";
      }

      const data = await apiGet<StreamContentsResponse>(
        `/reader/api/0/stream/contents/${encodeURIComponent("user/-/state/com.google/saved-web-pages")}`,
        queryParams
      );

      const result = {
        pages: data.items.map(formatArticle),
        continuation: data.continuation ?? null,
        total_returned: data.items.length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_article_content",
    "Get full HTML content for specific articles by ID. Use after get_articles or search_articles to read full content. Costs 1 Zone 1 request.",
    {
      article_ids: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Article IDs to fetch full content for (max 20)"),
    },
    async (params) => {
      const searchParams = new URLSearchParams();
      for (const id of params.article_ids) {
        searchParams.append("i", id);
      }

      const data = await apiPost<StreamItemContentsResponse>(
        "/reader/api/0/stream/items/contents",
        searchParams
      );

      const articles = data.items.map((item) => {
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(articles, null, 2),
          },
        ],
      };
    }
  );
}
