import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

function boundedInteger(min: number, max: number) {
  return z.string().regex(/^\d+$/).refine((value) => Number(value) >= min && Number(value) <= max, `Expected ${min}..${max}`);
}

function budgetAware(lines: string[]): string {
  return [
    "Before executing: read inoreader://usage and get_rate_limit_status (both zero-request). Header quotas are observed snapshots; missing/expired quota is unknown. Costs below are base calls; read retries can add up to 4 attempts per call. Avoid duplicate expensive scans, honor budget/cooldown and continuation/cap flags, and stop after the bounded batch. Propose writes for approval; never blindly replay an ambiguous write. Prompt retrieval itself performs no HTTP, writes or paid processing.",
    "",
    ...lines,
  ].join("\n");
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "triage-unread",
    {
      title: "Triage unread articles",
      description:
        "Review unread articles, summarize each, and suggest whether to read, star, or skip.",
      argsSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe("Limit to articles in this folder name"),
        count: boundedInteger(1, 100)
          .optional()
          .describe("Max articles to review (default 20)"),
      }),
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
              text: budgetAware([
                "Triage my unread articles and help me decide what deserves attention.",
                "",
                folderClause,
                "",
                "Steps:",
                `1. Call get_unread_counts to see the landscape.`,
                `2. Call get_articles with filter "unread"${args.folder ? `, stream_id "user/-/label/${args.folder}"` : ""}, count ${count}, include_total=false (1 Z1) to fetch a single page.`,
                "3. For each article, provide:",
                "   - Title and source",
                "   - One-sentence summary from the snippet",
                "   - Recommended action: READ (fetch full content), STAR (save for later), or SKIP (mark read)",
                "4. Group results by recommendation.",
                "5. Ask before executing any actions (starring or marking read).",
              ]),
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
      argsSchema: z.object({
        months: boundedInteger(1, 24)
          .optional()
          .describe("Time window in months to analyze (default 12)"),
        folder: z
          .string()
          .optional()
          .describe("Limit analysis to feeds in this folder"),
      }),
    },
    (args) => {
      const months = args.months ?? "12";
      const folderClause = args.folder
        ? `Limit analysis to the folder "${args.folder}".`
        : "Analyze all feeds.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: budgetAware([
                "Review my feed subscriptions for health and engagement.",
                "",
                folderClause,
                "",
                "Steps:",
                `1. Make ONE analyze_feeds call with months ${months}${args.folder ? `, folder "${args.folder}"` : ""}, sort_by "unengaged_per_month", limit 100, max_requests 100. It costs 3 metadata reads plus paginated engagement and per-feed volume reads (at most 100 base Z1); safe-read retries are extra. It preserves 25 known requests in reserve. Do not repeat this expensive scan just to sort it.`,
                "2. Compare summary counts to visible feeds. If truncated, capped, degraded or incomplete, say so: missing engagement is not evidence of no engagement. Ask before expanding the budget or running another scan.",
                "3. Reuse the returned feeds and group findings:",
                "   - DORMANT feeds (no content in 90+ days) -- suggest unsubscribe",
                "   - NEVER-ENGAGED feeds publishing actively -- suggest unsubscribe or try reading for a week",
                "   - HIGH-ENGAGEMENT feeds -- highlight as keepers",
                "4. Present a summary table with columns: Feed, Folder, Status, Engagement Rate, Articles, Recommendation.",
                "5. Summarize category-level priors from this response, noting incomplete scans and uncertainty.",
                "6. Ask for confirmation before executing any unsubscribes via manage_subscription. For large prune sets, confirm the count explicitly before acting.",
              ]),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "organize-uncategorized",
    {
      title: "Organize and rename uncategorized feeds",
      description:
        "Find feeds with no folder, propose cleaned-up titles, and suggest folder assignments based on existing structure.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: budgetAware([
              "Help me organize my uncategorized feeds: clean up their titles and assign them to folders.",
              "",
              "Steps:",
              "1. Call get_uncategorized_feeds with include_url true to see feeds without folders.",
              "2. Call list_folders_and_tags to see the existing folder structure.",
              "3. For each feed, propose a cleaned-up title. Strip filler like \"Blog on\", \"Posts on\", \"- blog\", \"blog feed\", \"'s Blog\", \"RSS\", and similar boilerplate. Prefer the author or publication name. Skip the rename if the current title is already clean.",
              "4. For each feed, suggest which existing folder it belongs in based on the title and URL. If the topic is unclear from those alone, fetch the site URL to read the about/intro before deciding. If no existing folder fits, propose a new one.",
              "5. Present all assignments as a table: Current Title, Proposed Title, URL, Suggested Folder, Reason.",
              "6. Ask for my approval, then execute:",
              "   - For each rename: call manage_subscription with action \"edit\", the stream_id, and the new title.",
              "   - For folder assignments: call categorize_feeds once with all assignments grouped by folder.",
            ]),
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
      argsSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe("Limit to articles in this folder"),
        hours: boundedInteger(1, 720)
          .optional()
          .describe("Look back this many hours (default 24)"),
      }),
    },
    (args) => {
      const hours = parseInt(args.hours ?? "24", 10);
      const sinceTimestamp = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const folderClause = args.folder
        ? `Focus on the folder "${args.folder}".`
        : "Cover all feeds.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: budgetAware([
                `Summarize articles from the last ${hours} hours.`,
                "",
                folderClause,
                "",
                "Steps:",
                `1. Call get_articles with filter "unread", since "${sinceTimestamp}"${args.folder ? `, stream_id "user/-/label/${args.folder}"` : ""}, count 50, include_total=false (1 Z1, one page).`,
                "2. Group articles by source feed.",
                "3. For each source, provide a 1-2 sentence summary of the themes covered.",
                "4. Highlight any articles that seem particularly important or unusual.",
                "5. Offer to fetch full content for interesting articles via get_article_content.",
              ]),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "analyze-classifier",
    {
      title: "Analyze LLM classifier calibration",
      description:
        "Build a reliability diagram for the Inoreader Intelligence classifier on verified-tagged articles. Reports per-bin Beta-Binomial posteriors, ECE, monotonicity violations, threshold diagnostic, Manski FNR bounds, and an audit-conditional recall posterior when audit data exists.",
      argsSchema: z.object({
        breakdown_by: z
          .string().regex(/^(feed|folder)(,\s*(feed|folder))?$/)
          .optional()
          .describe(
            "Comma-separated slices to additionally compute calibration on (feed, folder). Default: none.",
          ),
        bins: boundedInteger(2, 50)
          .optional()
          .describe("Number of equal-width score bins (default 10)."),
      }),
    },
    (args) => {
      const breakdownArg = args.breakdown_by
        ? `, breakdown_by=[${args.breakdown_by
            .split(",")
            .map((s) => `"${s.trim()}"`)
            .join(", ")}]`
        : "";
      const binsArg = args.bins ? `, bins=${args.bins}` : "";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: budgetAware([
                "Analyze the calibration of my Inoreader Intelligence classifier.",
                "",
                "Steps:",
                `1. Call analyze_classifier_calibration${binsArg}${breakdownArg} ONCE (4-80 base Z1 reads, with a maximum-page preflight plus 25 reserve). Do not run extract_classifier_data first: that repeats the same scan. No paid classifier processing is started.`,
                "2. Inspect data_summary: if verified_count is below 30, stop and suggest labeling more articles. If verified_hit_cap or population_hit_cap is true, disclose partial coverage before interpreting results.",
                "3. Present the per-bin reliability table with columns: bin range, n, k (worth-it count), posterior mean, 95% CI, smoothed mean, contains diagonal. Flag low_data bins.",
                "4. Surface the diagnostics:",
                "   - Precision (point estimate + CI) on the verified-recommended slice.",
                "   - ECE: if > 0.1, the classifier is meaningfully miscalibrated.",
                "   - Monotonicity violations: if any, the LLM is not rank-ordering articles cleanly. Suggest revising the prompt (more cautious framing, sharper criteria for 'read').",
                "   - Threshold diagnostic: report the lowest-score recommend-read bin and what its posterior implies for below-threshold articles by monotonicity.",
                "   - Manski FNR bounds (if include_population was used).",
                "   - Audit-conditional recall posterior (if audit data exists). If absent, recommend running recommend_audit_articles and reading 5-10 to populate it.",
                "5. If breakdown_by was set, briefly summarize which feeds or folders deviate from the overall calibration.",
                "6. Conclude with a one-line health verdict: well-calibrated / miscalibrated-overconfident / miscalibrated-underconfident / not-yet-rank-ordered.",
              ]),
            },
          },
        ],
      };
    },
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
            text: budgetAware([
              "Help me clean up my saved web pages.",
              "",
              "Steps:",
              '1. Optionally call get_saved_web_pages with count_only true (1 Z1). The count is one IDs page, capped at 10000; it is not a total unless total_is_exact=true.',
              '2. Call get_saved_web_pages with filter "removable", count 100, compact true (1 Z1). Review just this one page, not the entire account. Report its continuation and ask before another page. Removable is a candidate filter, not authorization to delete.',
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
            ]),
          },
        },
      ],
    })
  );
}
