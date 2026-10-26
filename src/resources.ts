import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { apiGet, apiPost } from "./api.js";
import { assertBudget } from "./rate-limit.js";
import { USAGE_GUIDE } from "./guidance.js";
import { normalizeItemId } from "./verify-tags.js";
import { snapshot } from "./rate-limit.js";
import type {
  SubscriptionListResponse,
  UnreadCountResponse,
  TagListResponse,
  StreamItemContentsResponse,
} from "./types.js";

export function registerResources(server: McpServer): void {
  server.registerResource("usage", "inoreader://usage", {
    title: "Inoreader usage, workflows and request costs",
    description: "Local guide with URI template examples, all prompt names, paging, quota provenance and safe write rules. Zero requests.",
    mimeType: "text/plain",
  }, (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: USAGE_GUIDE }] }));

  server.registerResource("article-content", new ResourceTemplate("inoreader://articles/{article_id}/content?max_chars={max_chars}", { list: undefined }), {
    title: "Bounded stored article content",
    description: "Stored article HTML and provenance. Percent-encode the ID; Required max_chars=1..20000 (8000 recommended). Costs 1 Zone 1 content POST (safe-read retries extra). No mutation, full-text extraction or paid processing. Example: inoreader://articles/123/content?max_chars=8000. See inoreader://usage.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    if (uri.hash) throw new Error("Article content URIs must not have a fragment");
    const id = z.string().max(128).regex(/^(?:[0-9a-fA-F]{1,32}|tag:google\.com,2005:reader\/item\/[0-9a-fA-F]{1,32})$/).parse(decodeURIComponent(String(variables.article_id)));
    const values = uri.searchParams.getAll("max_chars");
    if (values.length !== 1 || [...uri.searchParams.keys()].some((k) => k !== "max_chars")) throw new Error("Exactly one max_chars parameter is required");
    if (values[0] !== undefined && !/^\d+$/.test(values[0])) throw new Error("max_chars must be an integer from 1 to 20000");
    const maxChars = z.number().int().min(1).max(20000).parse(Number(values[0]));
    const data = await apiPost<StreamItemContentsResponse>("/reader/api/0/stream/items/contents", new URLSearchParams({ i: id, output: "json" }));
    const item = data.items?.find((i) => normalizeItemId(i.id) === normalizeItemId(id));
    if (!item) throw new Error("Article not available to this authorized account");
    const html = item.summary?.content ?? "";
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
      id: item.id.slice(0, 128), title: item.title.slice(0, 512),
      url: (item.canonical?.[0]?.href ?? item.alternate?.[0]?.href ?? "").slice(0, 2048),
      source: (item.origin?.title ?? "").slice(0, 512), published: item.published,
      content: html.slice(0, maxChars), content_truncated: html.length > maxChars,
      content_chars_available: html.length, max_chars: maxChars,
      provenance: { provider: "Inoreader", kind: "stored article HTML", observed_at: new Date().toISOString(), base_cost_zone1: 1 },
    }, null, 2) }] };
  });

  server.registerResource(
    "rate-limits",
    "inoreader://rate-limits",
    {
      description:
        "Cached/local Zone 1/2 quota observations, UTC local attempt counts, reset/cooldown timestamps and estimate provenance. No HTTP or auth probe: 0 requests. Missing/expired usage is unknown, not free calls. See inoreader://usage for request costs, template examples and prompts.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(snapshot(), null, 2),
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
        "RSS subscriptions with id, title, URL and folders (first 500; total/truncated disclosed). Costs 1 Zone 1 request; read retries extra. See list_subscriptions for local pagination.",
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
              { total: subscriptions.length, subscriptions: subscriptions.slice(0, 500), truncated: subscriptions.length > 500 },
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
        "Folder and tag structure (first 500 each; totals/truncation disclosed). Costs 2 Zone 1 requests; read retries extra.",
      mimeType: "application/json",
    },
    async (uri) => {
      assertBudget(1, 2, "folders resource");
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
            text: JSON.stringify({ folders: folders.slice(0, 500), tags: tags.slice(0, 500), total_folders: folders.length, total_tags: tags.length, truncated: folders.length > 500 || tags.length > 500 }, null, 2),
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
        "Unread counts per feed/folder (first 500 non-zero entries, descending; total entries/truncation disclosed). Costs 1 Zone 1 request; read retries extra. Counts overlap across feeds/folders: total_unread is not a deduplicated article count.",
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
              { total_unread: counts.reduce((sum, c) => sum + c.count, 0), total_entries: counts.length, counts: counts.slice(0, 500), truncated: counts.length > 500, note: "total_unread sums overlapping feed/folder counts, not distinct articles." },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
