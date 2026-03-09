import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, apiPost } from "../api.js";
import type { SubscriptionListResponse } from "../types.js";

export function registerSubscriptionTools(server: McpServer): void {
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
