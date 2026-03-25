import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import type { TagListResponse, UnreadCountResponse } from "../types.js";

const SYSTEM_TAGS: Record<string, string> = {
  read: "user/-/state/com.google/read",
  starred: "user/-/state/com.google/starred",
  like: "user/-/state/com.google/like",
  broadcast: "user/-/state/com.google/broadcast",
  "saved-web-pages": "user/-/state/com.google/saved-web-page",
  keep: "user/-/label/Keep",
};

function resolveTag(tag: string): string {
  return SYSTEM_TAGS[tag.toLowerCase()] ?? `user/-/label/${tag}`;
}

export function registerOrganizationTools(server: McpServer): void {
  server.tool(
    "manage_tags",
    "Mark articles as read/unread/starred, or apply/remove custom tags. To mark as read: add_tag='read'. To star: add_tag='starred'. To unstar: remove_tag='starred'. To save/unsave a web page: add/remove_tag='saved-web-pages'. To protect a saved web page from cleanup: add_tag='Keep'. Supports batch operations on multiple articles. Use friendly names: 'read', 'starred', 'like', 'broadcast', 'saved-web-pages', 'Keep', or any custom label name. Costs 1 Zone 2 request.",
    {
      article_ids: z
        .array(z.string())
        .describe("One or more article IDs to modify"),
      add_tag: z
        .string()
        .optional()
        .describe(
          "Tag to add: 'read', 'starred', 'like', 'broadcast', or a custom label name"
        ),
      remove_tag: z
        .string()
        .optional()
        .describe("Tag to remove (same options as add_tag)"),
    },
    async (params) => {
      if (!params.add_tag && !params.remove_tag) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: at least one of add_tag or remove_tag is required",
            },
          ],
          isError: true,
        };
      }

      const searchParams = new URLSearchParams();
      for (const id of params.article_ids) {
        searchParams.append("i", id);
      }
      if (params.add_tag) searchParams.append("a", resolveTag(params.add_tag));
      if (params.remove_tag) searchParams.append("r", resolveTag(params.remove_tag));

      await apiPost<string>("/reader/api/0/edit-tag", searchParams);

      const actions: string[] = [];
      if (params.add_tag) actions.push(`added "${params.add_tag}"`);
      if (params.remove_tag) actions.push(`removed "${params.remove_tag}"`);

      return {
        content: [
          {
            type: "text" as const,
            text: `${actions.join(" and ")} on ${params.article_ids.length} article(s)`,
          },
        ],
      };
    }
  );

  server.tool(
    "mark_all_read",
    "Mark all articles in a feed or folder as read. Costs 1 Zone 2 request.",
    {
      stream_id: z
        .string()
        .describe("Stream ID of the feed or folder to mark as read"),
      before: z
        .string()
        .optional()
        .describe(
          "ISO date - only mark items older than this as read (defaults to now)"
        ),
    },
    async (params) => {
      const ts = params.before
        ? String(Math.floor(new Date(params.before).getTime() / 1000))
        : String(Math.floor(Date.now() / 1000));

      await apiPost<string>("/reader/api/0/mark-all-as-read", {
        s: params.stream_id,
        ts,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Marked all items in ${params.stream_id} as read`,
          },
        ],
      };
    }
  );

  server.tool(
    "remove_saved_web_pages",
    "Remove saved web pages by article ID. Use get_saved_web_pages with filter 'removable' to find candidates (pages that are neither starred nor tagged 'Keep'). To protect a page from cleanup without starring it, use manage_tags with add_tag='Keep'. Costs 1 Zone 2 request.",
    {
      article_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Article IDs of saved web pages to remove"),
    },
    async (params) => {
      const searchParams = new URLSearchParams();
      for (const id of params.article_ids) {
        searchParams.append("i", id);
      }
      searchParams.append("r", "user/-/state/com.google/saved-web-page");

      await apiPost<string>("/reader/api/0/edit-tag", searchParams);

      return {
        content: [
          {
            type: "text" as const,
            text: `Removed ${params.article_ids.length} saved web page(s)`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_folders_and_tags",
    "List all folders, tags, and labels with their unread counts. Note: only unread_count is available here; total_count (including read items) requires a separate get_article_ids call per tag. Costs 1 Zone 1 request.",
    {},
    async () => {
      const [tags, unreadData] = await Promise.all([
        apiGet<TagListResponse>("/reader/api/0/tag/list", { output: "json" }),
        apiGet<UnreadCountResponse>("/reader/api/0/unread-count", {
          output: "json",
        }),
      ]);

      const unreadMap = new Map(
        unreadData.unreadcounts.map((c) => [c.id, c.count])
      );

      const result = tags.tags.map((t) => ({
        id: t.id,
        type: t.type ?? "tag",
        unread_count: unreadMap.get(t.id) ?? 0,
      }));

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
    "batch_manage_tags",
    "Apply different tags to different groups of articles in one call. Useful for triage workflows where you categorize items into multiple groups at once. Each operation is one API call. Costs 1 Zone 2 request per operation.",
    {
      operations: z
        .array(
          z.object({
            article_ids: z
              .array(z.string())
              .min(1)
              .describe("Article IDs to modify"),
            add_tag: z
              .string()
              .optional()
              .describe("Tag to add: 'read', 'starred', 'like', 'broadcast', or a custom label name"),
            remove_tag: z
              .string()
              .optional()
              .describe("Tag to remove (same options as add_tag)"),
          })
        )
        .min(1)
        .describe("Array of tag operations to perform"),
    },
    async (params) => {
      const results: { index: number; article_count: number; ok: boolean; error?: string }[] = [];

      for (let i = 0; i < params.operations.length; i++) {
        const op = params.operations[i];
        if (!op.add_tag && !op.remove_tag) {
          results.push({ index: i, article_count: op.article_ids.length, ok: false, error: "at least one of add_tag or remove_tag is required" });
          continue;
        }
        try {
          const searchParams = new URLSearchParams();
          for (const id of op.article_ids) {
            searchParams.append("i", id);
          }
          if (op.add_tag) searchParams.append("a", resolveTag(op.add_tag));
          if (op.remove_tag) searchParams.append("r", resolveTag(op.remove_tag));
          await apiPost<string>("/reader/api/0/edit-tag", searchParams);
          results.push({ index: i, article_count: op.article_ids.length, ok: true });
        } catch (e) {
          results.push({
            index: i,
            article_count: op.article_ids.length,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total_operations: params.operations.length,
                succeeded,
                failed,
                errors: failed > 0 ? results.filter((r) => !r.ok) : undefined,
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
