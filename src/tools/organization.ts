import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import { applyTagIntents, type TagIntent } from "../verify-tags.js";
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
    "Mark articles as read/unread/starred, or apply/remove custom tags. To mark as read: add_tag='read'. To star: add_tag='starred'. To unstar: remove_tag='starred'. To save/unsave a web page: add/remove_tag='saved-web-pages'. To protect a saved web page from cleanup: add_tag='Keep'. Supports batch operations on multiple articles. Use friendly names: 'read', 'starred', 'like', 'broadcast', 'saved-web-pages', 'Keep', or any custom label name. Costs 1 Zone 2 request per 50 articles, plus 1 Zone 1 request per 50 to read the tags back. Reports `verified` (confirmed on the server) separately from `unverified`, and sets an error when fewer landed than requested.",
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

      const report = await applyTagIntents(
        params.article_ids.map((id) => ({
          articleId: id,
          ...(params.add_tag ? { addTag: params.add_tag } : {}),
          ...(params.remove_tag ? { removeTag: params.remove_tag } : {}),
        })),
        resolveTag
      );

      // This used to return "added X on N article(s)" -- a count of what was
      // requested, never of what applied. These tags are the calibration tools'
      // ground truth, so an unnoticed drop corrupts the analysis downstream.
      const notApplied = report.items.filter((i) => i.status !== "verified");
      return {
        isError: report.verified < report.intended,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...(params.add_tag ? { added: params.add_tag } : {}),
                ...(params.remove_tag ? { removed: params.remove_tag } : {}),
                intended: report.intended,
                verified: report.verified,
                unverified: report.unverified,
                failed: report.failed,
                not_attempted: report.not_attempted,
                verification: report.verification,
                rounds: report.rounds,
                ...(report.verify_error ? { warning: report.verify_error } : {}),
                ...(notApplied.length > 0 ? { not_applied: notApplied } : {}),
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
    "Remove saved web pages by article ID. Use get_saved_web_pages with filter 'removable' to find candidates (pages that are neither starred nor tagged 'Keep'). To protect a page from cleanup without starring it, use manage_tags with add_tag='Keep'. Costs 1 Zone 2 request per 50 pages plus Zone 1 reads to verify; reports only removals confirmed on the server.",
    {
      article_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Article IDs of saved web pages to remove"),
    },
    async (params) => {
      // Previously reported the size of the request ("Removed N saved web page(s)")
      // whether or not anything was removed.
      const report = await applyTagIntents(
        params.article_ids.map((id) => ({ articleId: id, removeTag: "saved-web-pages" })),
        resolveTag
      );
      const notApplied = report.items.filter((i) => i.status !== "verified");
      return {
        isError: report.verified < report.intended,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                intended: report.intended,
                removed: report.verified,
                unverified: report.unverified,
                failed: report.failed,
                not_attempted: report.not_attempted,
                verification: report.verification,
                rounds: report.rounds,
                ...(report.verify_error ? { warning: report.verify_error } : {}),
                ...(notApplied.length > 0 ? { not_applied: notApplied } : {}),
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
    "Apply different tags to different groups of articles in one call. Useful for triage workflows where you categorize items into multiple groups at once. Costs 1 Zone 2 request per 50 articles per operation, plus Zone 1 reads to verify. Reports verified/unverified per article and per operation, and sets an error when fewer landed than requested.",
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
      // Flatten every operation into per-article intents so the result can report
      // what landed per ARTICLE. The old shape counted operations and echoed
      // `article_count: op.article_ids.length` -- the size of the request, which
      // says nothing at all when an operation partially applies.
      const invalid: Array<{ index: number; error: string }> = [];
      const intents: TagIntent[] = [];
      const owner = new Map<string, number>();

      params.operations.forEach((op, i) => {
        if (!op.add_tag && !op.remove_tag) {
          invalid.push({ index: i, error: "at least one of add_tag or remove_tag is required" });
          return;
        }
        for (const id of op.article_ids) {
          owner.set(id, i);
          intents.push({
            articleId: id,
            ...(op.add_tag ? { addTag: op.add_tag } : {}),
            ...(op.remove_tag ? { removeTag: op.remove_tag } : {}),
          });
        }
      });

      const report = intents.length
        ? await applyTagIntents(intents, resolveTag)
        : {
            intended: 0, verified: 0, unverified: 0, failed: 0, not_attempted: 0,
            rounds: 0, verification: "none" as const, items: [],
          };

      const perOp = params.operations.map((op, i) => {
        const mine = report.items.filter((it) => owner.get(it.article_id) === i);
        return {
          index: i,
          ...(op.add_tag ? { add_tag: op.add_tag } : {}),
          ...(op.remove_tag ? { remove_tag: op.remove_tag } : {}),
          intended: mine.length,
          verified: mine.filter((m) => m.status === "verified").length,
          unverified: mine.filter((m) => m.status === "unverified").length,
          failed: mine.filter((m) => m.status === "failed").length,
        };
      });

      const notApplied = report.items.filter((i) => i.status !== "verified");

      return {
        isError: report.verified < report.intended || invalid.length > 0,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                operations: perOp,
                intended: report.intended,
                verified: report.verified,
                unverified: report.unverified,
                failed: report.failed,
                not_attempted: report.not_attempted,
                verification: report.verification,
                rounds: report.rounds,
                ...(report.verify_error ? { warning: report.verify_error } : {}),
                ...(invalid.length > 0 ? { rejected_operations: invalid } : {}),
                ...(notApplied.length > 0 ? { not_applied: notApplied } : {}),
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
