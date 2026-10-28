import { apiGet, apiPost } from "../../api.js";
import type { ArticleItem, StreamContentsResponse, StreamItemContentsResponse, StreamItemIdsResponse } from "../../types.js";
import { normalizeItemId } from "../../verify-tags.js";
import type { Highlight } from "../store.js";
import { cleanHtml } from "../text.js";
import { articleUrl, normalizeUrl } from "../urls.js";
import type { ItemCandidate } from "./types.js";

// Everything goes through apiGet/apiPost, so admission, Zone 1 accounting and
// retries apply, and each request keeps the same 25-read reserve analyze_feeds does.

export const ANNOTATED_STREAM = "user/-/state/com.google/annotated";
export const RESERVE = 25;
export const IDS_LIMIT = 10_000;
export const CONTENT_BATCH = 100;
export const ANNOTATION_PAGE = 100;
/** Safety cap on annotated-stream paging: 100 pages of 100 items. */
export const MAX_ANNOTATION_PAGES = 100;

/** Item ids are namespaced per adapter so they cannot collide with another kind of member. */
export function extIdOf(id: string): string {
  return `ino:${normalizeItemId(id)}`;
}

export interface StreamIds {
  /** The id as Inoreader returned it (decimal), which stream/items/contents accepts. */
  refs: Array<{ raw: string; ext: string }>;
  /** More than IDS_LIMIT items: only the newest were listed, so absences prove nothing. */
  truncated: boolean;
}

/** Safety cap on ids paging: MAX_ID_PAGES x IDS_LIMIT members per stream. */
export const MAX_ID_PAGES = 10;

/** One Zone 1 read per IDS_LIMIT members: the full membership of a stream. */
export async function fetchStreamIds(stream: string): Promise<StreamIds> {
  const refs: StreamIds["refs"] = [];
  let continuation: string | undefined;
  let pages = 0;
  do {
    const params: Record<string, string> = { s: stream, n: String(IDS_LIMIT), output: "json" };
    if (continuation) params.c = continuation;
    const data = await apiGet<StreamItemIdsResponse>("/reader/api/0/stream/items/ids", params, { reserve: RESERVE });
    pages++;
    for (const r of data.itemRefs ?? []) refs.push({ raw: String(r.id), ext: extIdOf(String(r.id)) });
    continuation = data.continuation || undefined;
  } while (continuation && pages < MAX_ID_PAGES);
  return { refs, truncated: Boolean(continuation) };
}

/** Zone 1: one POST per CONTENT_BATCH ids. Returns items keyed by ext id. */
export async function fetchContents(rawIds: string[]): Promise<Map<string, ArticleItem>> {
  const out = new Map<string, ArticleItem>();
  for (let i = 0; i < rawIds.length; i += CONTENT_BATCH) {
    const body = new URLSearchParams();
    for (const id of rawIds.slice(i, i + CONTENT_BATCH)) body.append("i", id);
    const data = await apiPost<StreamItemContentsResponse>("/reader/api/0/stream/items/contents", body, undefined, { reserve: RESERVE });
    for (const item of data.items ?? []) out.set(extIdOf(item.id), item);
  }
  return out;
}

export function contentBatches(n: number): number {
  return Math.ceil(n / CONTENT_BATCH);
}

/** The annotated stream, one Zone 1 read per ANNOTATION_PAGE items. */
export async function fetchAnnotated(
  onPage?: () => void,
): Promise<{ items: ArticleItem[]; complete: boolean; pages: number }> {
  const items: ArticleItem[] = [];
  let continuation: string | undefined;
  let pages = 0;
  do {
    const params: Record<string, string> = { output: "json", n: String(ANNOTATION_PAGE), annotations: "1" };
    if (continuation) params.c = continuation;
    const data = await apiGet<StreamContentsResponse>(
      `/reader/api/0/stream/contents/${encodeURIComponent(ANNOTATED_STREAM)}`,
      params,
      { reserve: RESERVE },
    );
    pages++;
    onPage?.();
    items.push(...(data.items ?? []));
    continuation = data.continuation || undefined;
  } while (continuation && pages < MAX_ANNOTATION_PAGES);
  return { items, complete: !continuation, pages };
}

/** Null when the item has no usable URL: it cannot be keyed, so it is not indexed. */
export function candidateFromArticle(item: ArticleItem): ItemCandidate | null {
  const url = articleUrl(item);
  const key = normalizeUrl(url);
  if (!key || !url) return null;
  const cleaned = cleanHtml(item.summary?.content ?? "");
  return {
    key,
    url,
    title: (item.title ?? "").replace(/\s+/g, " ").trim() || url,
    source_title: item.origin?.title ?? "",
    published: Number.isFinite(item.published) ? item.published : null,
    opening: cleaned.opening,
    headings: cleaned.headings,
    words: cleaned.words,
    text: cleaned.text,
  };
}

export function highlightsOf(item: ArticleItem): Highlight[] {
  return (item.annotations ?? []).map((a) => ({
    id: String(a.id),
    text: a.text ?? "",
    note: a.note ?? "",
    added_on: typeof a.added_on === "number" ? a.added_on : null,
  }));
}
