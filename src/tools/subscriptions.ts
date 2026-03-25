import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import type { SubscriptionListResponse } from "../types.js";

const BatchEditSchema = z.array(
  z.object({
    stream_id: z.string().describe("Stream ID of the feed"),
    add_to_folder: z.string().describe("Folder name to add the feed to"),
  })
);

async function assignFeedToFolder(
  streamId: string,
  folder: string
): Promise<{ streamId: string; folder: string; ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await apiPost<string>("/reader/api/0/subscription/edit", {
        ac: "edit",
        s: streamId,
        a: `user/-/label/${folder}`,
      });
      return { streamId, folder, ok: true };
    } catch (e) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        return {
          streamId,
          folder,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }
  return { streamId, folder, ok: false, error: "unreachable" };
}

export function registerSubscriptionTools(server: McpServer): void {
  server.tool(
    "batch_edit_subscriptions",
    "Deprecated: use categorize_feeds instead (more reliable, folder-centric input). Add multiple feeds to folders. Each edit costs 1 Zone 2 request.",
    {
      edits: BatchEditSchema.describe("Array of edits to apply"),
    },
    async (params) => {
      const assignments: Record<string, string[]> = {};
      for (const edit of params.edits) {
        if (!assignments[edit.add_to_folder]) assignments[edit.add_to_folder] = [];
        assignments[edit.add_to_folder].push(edit.stream_id);
      }

      const pairs: { streamId: string; folder: string }[] = [];
      for (const [folder, streamIds] of Object.entries(assignments)) {
        for (const streamId of streamIds) {
          pairs.push({ streamId, folder });
        }
      }

      const results: { streamId: string; folder: string; ok: boolean; error?: string }[] = [];
      const concurrency = 3;
      for (let i = 0; i < pairs.length; i += concurrency) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
        const batch = pairs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(({ streamId, folder }) => assignFeedToFolder(streamId, folder))
        );
        results.push(...batchResults);
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ succeeded, failed, details: failed > 0 ? results.filter((r) => !r.ok) : undefined }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_subscriptions",
    "List RSS feed subscriptions with their folders, URLs, and metadata. Supports filtering by folder and searching by title/URL. Returns paginated results (default 100). Costs 1 Zone 1 request.",
    {
      folder: z
        .string()
        .optional()
        .describe("Filter to subscriptions in this folder name"),
      search: z
        .string()
        .optional()
        .describe("Filter by title or URL (case-insensitive substring match)"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Max subscriptions to return (default 100)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of subscriptions to skip (default 0)"),
    },
    async (params) => {
      const data = await apiGet<SubscriptionListResponse>(
        "/reader/api/0/subscription/list",
        { output: "json" }
      );

      let subs = data.subscriptions.map((s) => ({
        id: s.id,
        title: s.title,
        feed_url: s.url,
        site_url: s.htmlUrl,
        folders: s.categories.map((c) => c.label),
      }));

      if (params.folder) {
        subs = subs.filter((s) =>
          s.folders.some(
            (f) => f.toLowerCase() === params.folder!.toLowerCase()
          )
        );
      }

      if (params.search) {
        const q = params.search.toLowerCase();
        subs = subs.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.feed_url.toLowerCase().includes(q) ||
            s.site_url.toLowerCase().includes(q)
        );
      }

      const total = subs.length;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 100;
      const page = subs.slice(offset, offset + limit);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              subscriptions: page,
              total,
              showing: `${offset + 1}-${offset + page.length} of ${total}`,
              ...(offset + page.length < total
                ? { next_offset: offset + limit }
                : {}),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_uncategorized_feeds",
    "Get feeds that have no folder assignment, returned as compact [stream_id, title] tuples. Use this to identify feeds needing categorization, then call categorize_feeds with your assignments. Costs 1 Zone 1 request.",
    {
      include_url: z
        .boolean()
        .optional()
        .describe("Include site URL as a third tuple element (default false)"),
    },
    async (params) => {
      const data = await apiGet<SubscriptionListResponse>(
        "/reader/api/0/subscription/list",
        { output: "json" }
      );

      const uncategorized = data.subscriptions.filter(
        (s) => s.categories.length === 0
      );

      const feeds = uncategorized.map((s) =>
        params.include_url
          ? [s.id, s.title, s.htmlUrl]
          : [s.id, s.title]
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                uncategorized_count: uncategorized.length,
                total_count: data.subscriptions.length,
                feeds,
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
    "categorize_feeds",
    "Assign feeds to folders in bulk. Pass a map of {folder_name: [stream_id, ...]}. Typical workflow: call get_uncategorized_feeds first, decide categories, then call this tool. Each feed assignment costs 1 Zone 2 request.",
    {
      assignments: z
        .record(
          z.string(),
          z.array(z.string())
        )
        .describe("Map of folder name to array of stream IDs to assign"),
    },
    async (params) => {
      const pairs: { streamId: string; folder: string }[] = [];
      for (const [folder, streamIds] of Object.entries(params.assignments)) {
        for (const streamId of streamIds) {
          pairs.push({ streamId, folder });
        }
      }

      const results: { streamId: string; folder: string; ok: boolean; error?: string }[] = [];
      const concurrency = 3;

      for (let i = 0; i < pairs.length; i += concurrency) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
        const batch = pairs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(({ streamId, folder }) => assignFeedToFolder(streamId, folder))
        );
        results.push(...batchResults);
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      const byFolder: Record<string, number> = {};
      for (const [folder, streamIds] of Object.entries(params.assignments)) {
        byFolder[folder] = streamIds.length;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: pairs.length,
                succeeded,
                failed,
                by_folder: byFolder,
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

  server.tool(
    "reassign_feeds",
    "Move feeds from one folder to another in bulk. Each feed costs 1 Zone 2 request (the add and remove happen in a single API call). Pass from_folder and a map of {new_folder: [stream_id, ...]}.",
    {
      from_folder: z
        .string()
        .describe("Folder name to remove all feeds from"),
      assignments: z
        .record(z.string(), z.array(z.string()))
        .describe("Map of new folder name to array of stream IDs to move there"),
    },
    async (params) => {
      const pairs: { streamId: string; toFolder: string }[] = [];
      for (const [toFolder, streamIds] of Object.entries(params.assignments)) {
        for (const streamId of streamIds) {
          pairs.push({ streamId, toFolder });
        }
      }

      const results: { streamId: string; toFolder: string; ok: boolean; error?: string }[] = [];
      const concurrency = 10;

      for (let i = 0; i < pairs.length; i += concurrency) {
        const batch = pairs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(async ({ streamId, toFolder }) => {
            try {
              await apiPost<string>("/reader/api/0/subscription/edit", {
                ac: "edit",
                s: streamId,
                a: `user/-/label/${toFolder}`,
                r: `user/-/label/${params.from_folder}`,
              });
              return { streamId, toFolder, ok: true as const };
            } catch (e) {
              return {
                streamId,
                toFolder,
                ok: false as const,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          })
        );
        results.push(...batchResults);
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      const byFolder: Record<string, number> = {};
      for (const [folder, streamIds] of Object.entries(params.assignments)) {
        byFolder[folder] = streamIds.length;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                from_folder: params.from_folder,
                total: pairs.length,
                succeeded,
                failed,
                by_folder: byFolder,
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

  server.tool(
    "rename_folder",
    "Rename a folder/label. All feeds in the old folder are moved to the new name. Costs 1 Zone 2 request.",
    {
      old_name: z.string().describe("Current folder name"),
      new_name: z.string().describe("New folder name"),
    },
    async (params) => {
      await apiPost<string>("/reader/api/0/rename-tag", {
        s: `user/-/label/${params.old_name}`,
        dest: `user/-/label/${params.new_name}`,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Renamed folder "${params.old_name}" to "${params.new_name}"`,
          },
        ],
      };
    }
  );

  server.tool(
    "manage_subscription",
    "Add, edit, or remove an RSS feed subscription. Costs 1 Zone 2 request.",
    {
      action: z
        .enum(["subscribe", "edit", "unsubscribe"])
        .describe("Action to perform"),
      feed_url: z
        .string()
        .optional()
        .describe("Feed URL (required for subscribe)"),
      stream_id: z
        .string()
        .optional()
        .describe("Stream ID of existing feed (required for edit/unsubscribe)"),
      title: z.string().optional().describe("New title for the feed"),
      add_to_folder: z
        .string()
        .optional()
        .describe("Folder name to add the feed to"),
      remove_from_folder: z
        .string()
        .optional()
        .describe("Folder name to remove the feed from"),
    },
    async (params) => {
      if (params.action === "subscribe") {
        if (!params.feed_url) {
          return {
            content: [
              { type: "text" as const, text: "Error: feed_url is required for subscribe action" },
            ],
            isError: true,
          };
        }

        const result = await apiPost<string>(
          "/reader/api/0/subscription/quickadd",
          { quickadd: params.feed_url }
        );

        // After subscribing, optionally set title and folder
        if (params.title || params.add_to_folder) {
          const streamId = `feed/${params.feed_url}`;
          const editBody: Record<string, string> = {
            ac: "edit",
            s: streamId,
          };
          if (params.title) editBody.t = params.title;
          if (params.add_to_folder) editBody.a = `user/-/label/${params.add_to_folder}`;
          await apiPost<string>("/reader/api/0/subscription/edit", editBody);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Subscribed to ${params.feed_url}${params.title ? ` as "${params.title}"` : ""}${params.add_to_folder ? ` in folder "${params.add_to_folder}"` : ""}`,
            },
          ],
        };
      }

      if (!params.stream_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: stream_id is required for edit/unsubscribe actions",
            },
          ],
          isError: true,
        };
      }

      if (params.action === "unsubscribe") {
        await apiPost<string>("/reader/api/0/subscription/edit", {
          ac: "unsubscribe",
          s: params.stream_id,
        });
        return {
          content: [
            { type: "text" as const, text: `Unsubscribed from ${params.stream_id}` },
          ],
        };
      }

      // edit
      const editBody: Record<string, string> = {
        ac: "edit",
        s: params.stream_id,
      };
      if (params.title) editBody.t = params.title;
      if (params.add_to_folder) editBody.a = `user/-/label/${params.add_to_folder}`;
      if (params.remove_from_folder) editBody.r = `user/-/label/${params.remove_from_folder}`;

      await apiPost<string>("/reader/api/0/subscription/edit", editBody);

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated subscription ${params.stream_id}`,
          },
        ],
      };
    }
  );
}
