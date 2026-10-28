import { karakeepCredentials, type KarakeepConfig } from "../config.js";
import type { SignalRow, TasteStore } from "../store.js";
import { cleanHtml } from "../text.js";
import { normalizeUrl } from "../urls.js";
import type { ItemCandidate, SourceBatch } from "./types.js";

// Karakeep REST API, checked against Karakeep v0.34.1 (packages/open-api/
// karakeep-openapi-spec.json, packages/shared/types/bookmarks.ts, packages/api/routes/bookmarks.ts):
//
//   GET {url}/api/v1/bookmarks?limit=100&cursor=<c>&includeContent=false
//       Authorization: Bearer <api key>
//     -> { bookmarks: Bookmark[], nextCursor: string | null }   (limit max 100)
//   GET {url}/api/v1/bookmarks/{id}?includeContent=true          -> Bookmark
//
//   Bookmark: { id, createdAt (ISO), title?, archived, favourited, note?, summary?,
//               source?, tags[], content }
//   Link content: { type: "link", url, title?, description?, htmlContent?,
//               crawlStatus: "success"|"failure"|"pending", crawledAt?, author?,
//               publisher?, datePublished?,
//               readerViewStatus: "readable"|"not_readable"|"uncertain"|"unavailable"|null,
//               readerViewScore: 0..100|null }
//   Other content types: "text", "asset", "unknown" (not indexed: no page URL).
//
// htmlContent is null unless includeContent=true (and is read from the content
// asset when large, so it is complete). readerViewStatus is Karakeep's own
// article classifier (score >= 70 readable, 35-69 uncertain, < 35 not_readable;
// it weighs article metadata, content length, link density and paragraph counts).
// This adapter prefers it over a word count: not_readable is skipped without
// fetching the page, readable is kept, and only where the classifier has no
// definite answer (uncertain, unavailable, not yet classified) does `min_words`
// decide. `use_reader_view: false` makes `min_words` the only test.

const PAGE = 100;
const TIMEOUT_MS = 30_000;
const CONTENT_CONCURRENCY = 4;
/** Safety cap on listing: 500 pages of 100. */
const MAX_PAGES = 500;

type FetchFn = typeof fetch;

interface KarakeepBookmark {
  id: string;
  createdAt?: string;
  title?: string | null;
  content?: {
    type?: string;
    url?: string;
    title?: string | null;
    description?: string | null;
    htmlContent?: string | null;
    crawlStatus?: string | null;
    crawledAt?: string | null;
    publisher?: string | null;
    datePublished?: string | null;
    readerViewStatus?: string | null;
    readerViewScore?: number | null;
  };
}

interface Page {
  bookmarks: KarakeepBookmark[];
  nextCursor: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(f: FetchFn, base: string, key: string, path: string): Promise<T> {
  let last: Error = new Error("unreachable");
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = (await res.text()).slice(0, 300);
    last = new Error(`Karakeep ${res.status} on GET ${path.split("?")[0]}: ${body}`);
    if (res.status !== 429 && res.status < 500) throw last; // a bad key or URL will not fix itself
    await sleep(500 * 2 ** attempt);
  }
  throw last;
}

export function karakeepExtId(id: string): string {
  return `kk:${id}`;
}

function seconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Re-judge a bookmark when anything the judgement used has changed. */
function fingerprint(b: KarakeepBookmark): string {
  const c = b.content ?? {};
  return [c.crawlStatus ?? "", c.readerViewStatus ?? "", c.readerViewScore ?? "", c.crawledAt ?? ""].join("|");
}

export interface KarakeepOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
}

/**
 * The whole bookmark list is re-read every sync (local, unmetered), which catches
 * deletions. Content is fetched only for bookmarks not yet judged, or whose crawl
 * or classification changed.
 */
export async function gatherKarakeep(source: KarakeepConfig, store: TasteStore, opts: KarakeepOptions = {}): Promise<SourceBatch> {
  const f = opts.fetch ?? fetch;
  const { url, key } = karakeepCredentials(source, opts.env);

  const listed: KarakeepBookmark[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const q = new URLSearchParams({ limit: String(PAGE), includeContent: "false" });
    if (cursor) q.set("cursor", cursor);
    const page: Page = await getJson<Page>(f, url, key, `/api/v1/bookmarks?${q}`);
    listed.push(...(page.bookmarks ?? []));
    cursor = page.nextCursor ?? null;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  const complete = !cursor;

  const links = listed.filter((b) => b.content?.type === "link" && b.content.url);
  const known = store.signalsOf(source.name);
  const present = new Set(links.map((b) => karakeepExtId(b.id)));
  const upserts: SignalRow[] = [];
  const candidates: ItemCandidate[] = [];

  const toJudge = links.filter((b) => {
    const prior = known.get(karakeepExtId(b.id));
    // Not crawled yet: nothing to judge. It is picked up once the crawl finishes.
    if (b.content?.crawlStatus === "pending") return false;
    return !prior || prior.fp !== fingerprint(b);
  });

  const judge = async (b: KarakeepBookmark): Promise<void> => {
    const c = b.content!;
    const ext = karakeepExtId(b.id);
    const fp = fingerprint(b);
    const skip = (): void => {
      upserts.push({ source: source.name, ext_id: ext, key: null, fp, added_at: null, highlights: [] });
    };
    const pageKey = normalizeUrl(c.url);
    if (!pageKey || c.crawlStatus === "failure") return skip();
    if (source.use_reader_view && c.readerViewStatus === "not_readable") return skip();

    const full = await getJson<KarakeepBookmark>(f, url, key, `/api/v1/bookmarks/${encodeURIComponent(b.id)}?includeContent=true`);
    const fc = full.content ?? c;
    const html = fc.htmlContent ?? "";
    const cleaned = cleanHtml(html);
    const description = (fc.description ?? "").trim();
    // A crawl with no body text still has Karakeep's description to index.
    const text = cleaned.text || description;
    if (!text) return skip();
    const words = cleaned.text ? cleaned.words : description.split(/\s+/).filter(Boolean).length;
    const definite = source.use_reader_view && c.readerViewStatus === "readable";
    if (!definite && words < source.min_words) return skip();

    candidates.push({
      key: pageKey,
      url: c.url!,
      title: (b.title || fc.title || "").replace(/\s+/g, " ").trim() || c.url!,
      source_title: (fc.publisher ?? "").trim() || new URL(c.url!).hostname.replace(/^www\./, ""),
      published: seconds(fc.datePublished) ?? null,
      opening: cleaned.text ? cleaned.opening : description,
      headings: cleaned.headings,
      words,
      text,
    });
    upserts.push({ source: source.name, ext_id: ext, key: pageKey, fp, added_at: seconds(b.createdAt), highlights: [] });
  };

  for (let i = 0; i < toJudge.length; i += CONTENT_CONCURRENCY) {
    await Promise.all(toJudge.slice(i, i + CONTENT_CONCURRENCY).map(judge));
  }

  return { source: source.name, present: complete ? present : null, upserts, candidates };
}
