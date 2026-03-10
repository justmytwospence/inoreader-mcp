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

export function registerSubscriptionTools(server: McpServer): void {
  server.tool(
    "batch_edit_subscriptions",
    "Add multiple feeds to folders in one call. Each edit costs 1 Zone 2 request. Pass an array of {stream_id, add_to_folder} objects.",
    {
      edits: BatchEditSchema.describe("Array of edits to apply"),
    },
    async (params) => {
      const results: { stream_id: string; folder: string; ok: boolean; error?: string }[] = [];
      for (const edit of params.edits) {
        try {
          await apiPost<string>("/reader/api/0/subscription/edit", {
            ac: "edit",
            s: edit.stream_id,
            a: `user/-/label/${edit.add_to_folder}`,
          });
          results.push({ stream_id: edit.stream_id, folder: edit.add_to_folder, ok: true });
        } catch (e) {
          results.push({
            stream_id: edit.stream_id,
            folder: edit.add_to_folder,
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
            text: JSON.stringify({ succeeded, failed, details: failed > 0 ? results.filter((r) => !r.ok) : undefined }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_subscriptions",
    "List all RSS feed subscriptions with their folders, URLs, and metadata. Costs 1 Zone 1 request.",
    {
      folder: z
        .string()
        .optional()
        .describe("Filter to subscriptions in this folder name"),
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
        icon_url: s.iconUrl ?? null,
      }));

      if (params.folder) {
        subs = subs.filter((s) =>
          s.folders.some(
            (f) => f.toLowerCase() === params.folder!.toLowerCase()
          )
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { subscriptions: subs, total: subs.length },
              null,
              2
            ),
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
      const concurrency = 10;

      for (let i = 0; i < pairs.length; i += concurrency) {
        const batch = pairs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(async ({ streamId, folder }) => {
            try {
              await apiPost<string>("/reader/api/0/subscription/edit", {
                ac: "edit",
                s: streamId,
                a: `user/-/label/${folder}`,
              });
              return { streamId, folder, ok: true as const };
            } catch (e) {
              return {
                streamId,
                folder,
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
