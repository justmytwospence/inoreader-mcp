import * as z from "zod/v4";

/** Keep the existing JSON text; clients that understand structured data need not parse it. */
export function jsonResult(value: object, isError = false) {
  return {
    isError,
    structuredContent: Array.isArray(value) ? { items: value } : value as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export const DateInput = z.string().min(1).max(128).refine(
  (value) => Number.isFinite(Date.parse(value)), "Expected a valid ISO date string",
);

export const ArticleIdsResultSchema = z.object({
  ids: z.array(z.string()).max(10000),
  count: z.number().int().nonnegative(),
  continuation: z.string().nullable(),
});

const SavedArticleSchema = z.object({
  id: z.string(), title: z.string(), source: z.string(),
  is_starred: z.boolean(), is_kept: z.boolean(),
  saved_via: z.array(z.enum(["starred", "saved_web_page", "keep"])),
}).loose();
export const SavedItemsResultSchema = z.object({
  items: z.array(SavedArticleSchema).max(3000),
  total_count: z.number().int().nonnegative(),
  by_collection: z.object({ starred: z.number().int(), saved_web_pages: z.number().int(), keep: z.number().int() }),
  complete: z.boolean(),
  unavailable_collections: z.array(z.string()).optional(),
  collections: z.record(z.string(), z.object({
    stream_id: z.string(), filter: z.enum(["all", "starred"]),
    pages: z.number().int(), count: z.number().int(), continuation: z.string().nullable(), error: z.string().nullable(),
  })),
  note: z.string(),
});
