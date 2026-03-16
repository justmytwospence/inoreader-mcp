import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet } from "./api.js";
import { getState } from "./rate-limit.js";
import type {
  SubscriptionListResponse,
  UnreadCountResponse,
  TagListResponse,
} from "./types.js";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "rate-limits",
    "inoreader://rate-limits",
    {
      description:
        "Current API rate limit usage and remaining budget. Zero cost (reads cached response headers).",
      mimeType: "application/json",
    },
    async (uri) => {
      const state = getState();

      const format = (zone: typeof state.zone1, name: string) => {
        const remaining =
          zone.limit > 0 ? zone.limit - zone.usage : "unknown";
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
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
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

  server.registerResource(
    "subscriptions",
    "inoreader://subscriptions",
    {
      description:
        "All RSS feed subscriptions with id, title, URL, and folder assignments. Costs 1 Zone 1 request (cached after first call).",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await apiGet<SubscriptionListResponse>(
        "/reader/api/0/subscription/list",
        { output: "json" }
      );

      const subscriptions = data.subscriptions.map((sub) => ({
        id: sub.id,
        title: sub.title,
        url: sub.url,
        html_url: sub.htmlUrl,
        folders: sub.categories.map((c) => c.label),
      }));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(
              { total: subscriptions.length, subscriptions },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerResource(
    "folders",
    "inoreader://folders",
    {
      description:
        "Folder and tag structure. Costs 1 Zone 1 request (cached after first call).",
      mimeType: "application/json",
    },
    async (uri) => {
      const [tagData, subData] = await Promise.all([
        apiGet<TagListResponse>("/reader/api/0/tag/list", { output: "json" }),
        apiGet<SubscriptionListResponse>("/reader/api/0/subscription/list", {
          output: "json",
        }),
      ]);

      // Build set of folder IDs from subscription categories
      const folderIds = new Set<string>();
      for (const sub of subData.subscriptions) {
        for (const cat of sub.categories) {
          folderIds.add(cat.id);
        }
      }

      const folders = tagData.tags
        .filter((t) => folderIds.has(t.id))
        .map((t) => {
          const label = t.id.replace(/^user\/[^/]+\/label\//, "");
          const feedCount = subData.subscriptions.filter((s) =>
            s.categories.some((c) => c.id === t.id)
          ).length;
          return { id: t.id, label, feed_count: feedCount };
        });

      const tags = tagData.tags
        .filter((t) => !folderIds.has(t.id))
        .map((t) => ({ id: t.id, type: t.type }));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify({ folders, tags }, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "unread-counts",
    "inoreader://unread-counts",
    {
      description:
        "Unread article counts per feed and folder (non-zero only, sorted descending). Costs 1 Zone 1 request (cached after first call).",
      mimeType: "application/json",
    },
    async (uri) => {
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
          newest_item_date: new Date(
            parseInt(c.newestItemTimestampUsec) / 1000
          ).toISOString(),
        }));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(
              { total_unread: counts.reduce((sum, c) => sum + c.count, 0), counts },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
