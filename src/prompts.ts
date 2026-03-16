import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "triage-unread",
    {
      title: "Triage unread articles",
      description:
        "Review unread articles, summarize each, and suggest whether to read, star, or skip.",
      argsSchema: {
        folder: z
          .string()
          .optional()
          .describe("Limit to articles in this folder name"),
        count: z
          .string()
          .optional()
          .describe("Max articles to review (default 20)"),
      },
    },
    (args) => {
      const count = args.count ?? "20";
      const folderClause = args.folder
        ? `Focus only on the folder "${args.folder}".`
        : "Review across all feeds.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Triage my unread articles and help me decide what deserves attention.",
                "",
                folderClause,
                "",
                "Steps:",
                `1. Call get_unread_counts to see the landscape.`,
                `2. Call get_articles with filter "unread"${args.folder ? `, stream "user/-/label/${args.folder}"` : ""}, limit ${count} to fetch articles.`,
                "3. For each article, provide:",
                "   - Title and source",
                "   - One-sentence summary from the snippet",
                "   - Recommended action: READ (fetch full content), STAR (save for later), or SKIP (mark read)",
                "4. Group results by recommendation.",
                "5. Ask before executing any actions (starring or marking read).",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "feed-health-review",
    {
      title: "Review feed health",
      description:
        "Analyze feed engagement and identify candidates for unsubscribe or reorganization.",
      argsSchema: {
        months: z
          .string()
          .optional()
          .describe("Time window in months to analyze (default 3)"),
        folder: z
          .string()
          .optional()
          .describe("Limit analysis to feeds in this folder"),
      },
    },
    (args) => {
      const months = args.months ?? "3";
      const folderClause = args.folder
        ? `Limit analysis to the folder "${args.folder}".`
        : "Analyze all feeds.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Review my feed subscriptions for health and engagement.",
                "",
                folderClause,
                "",
                "Steps:",
                `1. Call analyze_feeds with months ${months}${args.folder ? `, folder "${args.folder}"` : ""}, sort_by "credible_lower".`,
                "2. Present a summary table with columns: Feed, Folder, Status, Engagement Rate, Articles, Recommendation.",
                "3. Group findings:",
                "   - DORMANT feeds (no content in 90+ days) -- suggest unsubscribe",
                "   - NEVER-ENGAGED feeds -- suggest unsubscribe or try reading for a week",
                "   - HIGH-ENGAGEMENT feeds -- highlight as keepers",
                "4. Summarize the category-level priors to show which folders have the best engagement.",
                "5. Ask for confirmation before executing any unsubscribes via manage_subscription.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "organize-uncategorized",
    {
      title: "Organize uncategorized feeds",
      description:
        "Find feeds with no folder and suggest folder assignments based on existing structure.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Help me organize my uncategorized feeds into folders.",
              "",
              "Steps:",
              "1. Call get_uncategorized_feeds with include_url true to see feeds without folders.",
              "2. Call list_folders_and_tags to see the existing folder structure.",
              "3. For each uncategorized feed, suggest which existing folder it belongs in based on the feed title and URL. If no existing folder fits, propose a new folder name.",
              "4. Present all assignments as a table: Feed Title, URL, Suggested Folder, Reason.",
              "5. Ask for my approval, then execute the assignments via categorize_feeds.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "summarize-recent",
    {
      title: "Summarize recent articles",
      description:
        "Digest of recent articles grouped by source with key themes highlighted.",
      argsSchema: {
        folder: z
          .string()
          .optional()
          .describe("Limit to articles in this folder"),
        hours: z
          .string()
          .optional()
          .describe("Look back this many hours (default 24)"),
      },
    },
    (args) => {
      const hours = parseInt(args.hours ?? "24", 10);
      const sinceTimestamp = Math.floor(
        (Date.now() - hours * 60 * 60 * 1000) / 1000
      );
      const folderClause = args.folder
        ? `Focus on the folder "${args.folder}".`
        : "Cover all feeds.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Summarize articles from the last ${hours} hours.`,
                "",
                folderClause,
                "",
                "Steps:",
                `1. Call get_articles with filter "unread", since ${sinceTimestamp}${args.folder ? `, stream "user/-/label/${args.folder}"` : ""}, limit 50.`,
                "2. Group articles by source feed.",
                "3. For each source, provide a 1-2 sentence summary of the themes covered.",
                "4. Highlight any articles that seem particularly important or unusual.",
                "5. Offer to fetch full content for interesting articles via get_article_content.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "review-saved-web-pages",
    {
      title: "Review saved web pages",
      description:
        "Review saved web pages, decide which to keep or remove. Pages protected by starring or the Keep tag are preserved.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Help me clean up my saved web pages.",
              "",
              "Steps:",
              '1. Call get_saved_web_pages with count_only true to show how many total saved pages exist.',
              '2. Call get_saved_web_pages with filter "removable" to fetch pages that are neither starred nor tagged Keep. Paginate with continuation tokens until all removable pages are fetched.',
              "3. Categorize each removable page into KEEP or REMOVE. The key question is: will this link be revisited?",
              "   KEEP candidates (bookmarkable, revisitable):",
              "   - Interactive tools, visualizations, simulators, games",
              "   - Reference material: cheat sheets, API docs, data tables, spec pages",
              "   - Educational explainers with interactive or visual elements",
              "   - Useful repos, tools, or services you'd come back to",
              "   - Live dashboards or trackers with ongoing value",
              "   REMOVE candidates (already consumed or ephemeral):",
              "   - Articles, essays, blog posts, opinion pieces -- already read, won't revisit",
              "   - Job listings, product/store pages, social media posts, pricing pages",
              "   - Setup guides or docs for a task likely already completed",
              "   - Homepages, blog indexes, or landing pages with no specific content",
              "   - Duplicates: same URL saved multiple times (remove all copies)",
              "   - Low-signal: pages with no meaningful summary or empty content",
              "4. Present your categorization as two tables (KEEP and REMOVE), each with columns: Title, Source, Reason.",
              "   Flag any borderline calls so I can override them.",
              "5. Ask me to confirm or adjust the categorization.",
              "6. After confirmation, execute in two batches:",
              "   - manage_tags with add_tag='Keep' for the keepers",
              "   - remove_saved_web_pages for the removals",
              "7. Show a final summary: counts kept, removed, and total remaining.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
