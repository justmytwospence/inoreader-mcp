import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { jsonResult } from "../contracts.js";
import { getTasteIndex } from "../taste/index.js";

const POINTER = "See inoreader://usage for the taste index workflow.";

/**
 * The taste index tools. Registered only when INOREADER_TASTE_INDEX=on, so a
 * server without the index (stdio users included) exposes exactly the same tools
 * as before. Tier names come from the configuration, so `prefer` is an enum of the
 * tiers this deployment really has.
 */
export function registerTasteTools(server: McpServer): void {
  const taste = getTasteIndex();
  if (!taste) return;
  const { config } = taste;
  const tierNames = config.tiers.map((t) => t.name);
  const tierList = config.tiers.map((t) => `${t.name} (${t.sources.join(", ")})`).join("; then ");
  const PreferTier = z.enum(tierNames as [string, ...string[]]);
  const sourceNames = config.sources.map((s) => s.name);
  const SourceName = z.enum(sourceNames as [string, ...string[]]);
  const Domains = z.array(z.string().min(1).max(253)).max(200);
  // Composable, generic result filters; every given one must pass. They describe the
  // text and where it came from, not whether it is good.
  const filterShape = {
    min_words: z.number().int().min(0).optional().describe("Only items with at least this many words (whole stored text)"),
    max_words: z.number().int().min(0).optional().describe("Only items with at most this many words"),
    include_domains: Domains.optional().describe("Only items from these domains or their subdomains, e.g. [\"substack.com\"]"),
    exclude_domains: Domains.optional().describe("Leave out items from these domains or their subdomains, e.g. [\"github.com\"]"),
    sources: z.array(SourceName).min(1).optional().describe(`Only items held by at least one of these configured sources: ${sourceNames.join(", ")}`),
    min_prose_paragraphs: z
      .number().int().min(0).max(20).optional()
      .describe("Only items whose opening (first ~1,200 characters) has at least this many prose paragraphs: 25+ words ending in sentence punctuation. A coarse article-vs-page filter (READMEs, product pages and lists mostly have 0-1)"),
  };
  const FILTER_DOC =
    "Optional filters (all must pass): min_words/max_words, include_domains/exclude_domains (subdomains included), sources (configured source names), min_prose_paragraphs (article-like openings). ";

  server.registerTool(
    "similar_saved",
    {
      title: "Find similar saved articles",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Find what the user already saved that is closest in topic to a piece of text (a draft, a claim, an outline), as exemplars of form and substance. " +
        `Matches are drawn from the preferred tier first, then widened to the other tiers to fill k. Tiers, narrowest first: ${tierList}. Default tier: ${config.default_tier}. ` +
        FILTER_DOC +
        "Set fill=false to return only the preferred tier. " +
        "Each result has title, URL, domain, source, published/saved dates, the signals (which sources hold it), tier, similarity (0-1, cosine of local embeddings), word count, prose_paragraphs and prose_ratio of the opening, an excerpt (the opening, or more when stored), headings and the user's highlights, plus the filters applied and index coverage, so a client can filter or rank further itself. " +
        "Similarity is topical overlap, not quality. Costs 0 Inoreader requests: it searches the local index (the first call may load the embedding model). If the index is still building, coverage says so. " +
        POINTER,
      inputSchema: z.object({
        text: z.string().min(1).max(20_000).describe("The text to match. Only roughly the first 512 tokens are used."),
        k: z.number().int().min(1).max(20).optional().describe("Results to return (1-20, default 5)"),
        prefer: PreferTier.optional().describe(`Tier to draw from first (default ${config.default_tier}); wider tiers fill the rest`),
        min_similarity: z.number().min(0).max(1).optional().describe("Drop matches below this cosine similarity (default 0.55)"),
        excerpt_chars: z.number().int().min(100).max(4000).optional().describe("Excerpt length per result (100-4000, default 800)"),
        fill: z.boolean().optional().describe("Fill k from wider tiers when the preferred tier has too few matches (default true)"),
        ...filterShape,
      }),
    },
    async (params) => jsonResult(await taste.similar(params)),
  );

  server.registerTool(
    "check_novelty",
    {
      title: "Check an idea against saved articles",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Warn when an idea repeats something already saved. Returns verdict 'close' when the nearest saved article (any tier) is at or above the threshold, else 'novel', with the nearest articles and their similarity. " +
        `Default threshold ${config.novelty_threshold}. Similarity measures topical overlap, not the quality of the idea or whether it is worth writing; an idea on the same topic but a different point can score as high as a restatement, so read the nearest items' similarity rather than trusting the verdict alone. ` +
        FILTER_DOC +
        "Each nearest item has title, URL, domain, signals, tier, similarity, word count and an excerpt. " +
        "Costs 0 Inoreader requests (local index; the first call may load the embedding model). If the index is empty or still building, 'novel' may only mean unknown: check coverage. " +
        POINTER,
      inputSchema: z.object({
        idea: z.string().min(1).max(20_000).describe("The idea or thesis, a sentence or a short paragraph"),
        threshold: z.number().gt(0).lte(1).optional().describe(`Cosine similarity at or above which the idea counts as close (default ${config.novelty_threshold})`),
        k: z.number().int().min(1).max(10).optional().describe("Nearest articles to return (1-10, default 3)"),
        ...filterShape,
      }),
    },
    async (params) => jsonResult(await taste.novelty(params)),
  );

  server.registerTool(
    "taste_index_status",
    {
      title: "Taste index status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Report the taste index: configured sources and tiers, item counts by source and tier, the last sync per source, Zone 1 reads per sync, errors, the model, and whether the index is complete. " +
        "Costs 0 Inoreader requests. Karakeep credentials are reported only as set or unset. " +
        POINTER,
      inputSchema: z.object({}),
    },
    async () => jsonResult(taste.status()),
  );

  server.registerTool(
    "sync_taste_index",
    {
      title: "Sync the taste index now",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Update the taste index from Inoreader (and Karakeep, if configured) now, instead of waiting for the scheduled sync every 12 hours. Writes only the local index; nothing in the Inoreader account changes. " +
        "Costs about 3-5 Zone 1 reads for an incremental sync and about 55 for a first full build of ~1,000 items: one ids read per stream source, one content read per 20 new items, one annotations read per 100 highlighted items. " +
        "It keeps 25 reads in reserve and is refused with the index unchanged when quota is short. Joins a sync already running. Safe to repeat. " +
        POINTER,
      inputSchema: z.object({}),
    },
    async () => {
      const report = await taste.sync();
      return jsonResult({ ...report, coverage: taste.coverage() });
    },
  );
}
