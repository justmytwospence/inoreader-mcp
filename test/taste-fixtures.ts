// Shared helpers for the taste-index tests: a deterministic embedder and fake
// Inoreader / Karakeep servers behind a stubbed fetch. Imported by each test file
// before anything that reads INOREADER_CONFIG_DIR, so it sets the variable itself.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TasteConfig } from "../src/taste/config.js";
import type { Embedder } from "../src/taste/embed.js";
import type { Highlight } from "../src/taste/store.js";

export const dir = mkdtempSync(join(tmpdir(), "inoreader-taste-"));
writeFileSync(
  join(dir, "tokens.json"),
  JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.parse("2099-01-01") }),
);
process.env.INOREADER_CONFIG_DIR = dir;
const rate = await import("../src/rate-limit.js");

export const cleanup = () => rmSync(dir, { recursive: true, force: true });

/** Tells the rate limiter what Inoreader reported, as a response would. */
export function setZone1(limit: number, usage: number): void {
  rate.updateFromHeaders(
    new Headers({ "x-reader-zone1-limit": String(limit), "x-reader-zone1-usage": String(usage), "x-reader-limits-reset-after": "3600" }),
  );
}
export const zone1Attempts = () => rate.getState().zone1.attemptCount ?? 0;

// --- embedder -----------------------------------------------------------------

export const DIMS = 64;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** A hashed bag of words, normalized: texts that share words are similar, deterministically. */
export function bagVector(text: string, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[hash(w) % dims] += 1;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export class FakeEmbedder implements Embedder {
  readonly model = "fake";
  readonly dtype = "fake";
  calls: string[][] = [];
  failWith?: string;
  /** Exact vectors for chosen texts; anything else is a bag of words. */
  table = new Map<string, Float32Array>();
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    if (this.failWith) throw new Error(this.failWith);
    return texts.map((t) => this.table.get(t) ?? bagVector(t));
  }
  async close(): Promise<void> {}
  get embeddedCount(): number {
    return this.calls.reduce((n, c) => n + c.length, 0);
  }
}

// --- Inoreader ----------------------------------------------------------------

export interface FakeAnnotation { id: number; text: string; note?: string; added_on?: number }
export interface FakeItem {
  /** Decimal id, as stream/items/ids returns it. */
  id: string;
  url?: string;
  title: string;
  html: string;
  origin?: string;
  published?: number;
  annotations?: FakeAnnotation[];
}

export const longId = (dec: string) => `tag:google.com,2005:reader/item/${BigInt(dec).toString(16).padStart(16, "0")}`;

export class FakeInoreader {
  streams = new Map<string, FakeItem[]>();
  annotated: FakeItem[] = [];
  annotationPageSize = 2;
  /** Report a continuation on ids, as a stream past the 10000 limit does. */
  truncated = false;
  failIds?: number;
  /** Fail this many content POSTs (500) before answering normally. */
  failContents = 0;
  /** Every request, "METHOD path" (plus stream for ids). */
  calls: string[] = [];
  contentBodies: string[][] = [];

  private all(): FakeItem[] {
    return [...this.streams.values(), this.annotated].flat();
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  private wire(item: FakeItem, withAnnotations: boolean) {
    return {
      id: longId(item.id),
      crawlTimeMsec: "0",
      timestampUsec: "0",
      published: item.published ?? 1_700_000_000,
      title: item.title,
      summary: { content: item.html },
      ...(item.url ? { canonical: [{ href: item.url }] } : {}),
      origin: { streamId: "feed/x", title: item.origin ?? "Some Feed", htmlUrl: "https://feed.example" },
      categories: [],
      ...(withAnnotations ? { annotations: (item.annotations ?? []).map((a) => ({ start: 0, end: 1, ...a })) } : {}),
    };
  }

  handle(url: URL, init?: RequestInit): Response {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/reader/api/0/stream/items/ids") {
      const stream = url.searchParams.get("s")!;
      this.calls.push(`GET ids ${stream}`);
      if (this.failIds) return this.json({ error: "boom" }, this.failIds);
      const items = this.streams.get(stream) ?? [];
      return this.json({
        itemRefs: items.map((i) => ({ id: i.id, timestampUsec: "0" })),
        ...(this.truncated ? { continuation: "more" } : {}),
      });
    }
    if (method === "POST" && path === "/reader/api/0/stream/items/contents") {
      const ids = new URLSearchParams(String(init?.body)).getAll("i");
      this.calls.push("POST contents");
      this.contentBodies.push(ids);
      if (this.failContents > 0) {
        this.failContents--;
        return this.json({ error: "boom" }, 400);
      }
      const wanted = new Set(ids.map((i) => BigInt(i).toString()));
      const found = this.all().filter((i) => wanted.has(BigInt(i.id).toString()));
      const unique = [...new Map(found.map((i) => [i.id, i])).values()];
      return this.json({ items: unique.map((i) => this.wire(i, false)) });
    }
    if (method === "GET" && path === `/reader/api/0/stream/contents/${encodeURIComponent("user/-/state/com.google/annotated")}`) {
      this.calls.push("GET annotated");
      assertParam(url, "annotations", "1");
      const start = Number(url.searchParams.get("c") ?? 0);
      const page = this.annotated.slice(start, start + this.annotationPageSize);
      const next = start + this.annotationPageSize;
      return this.json({
        direction: "ltr", id: "annotated", title: "Annotated",
        items: page.map((i) => this.wire(i, true)),
        ...(next < this.annotated.length ? { continuation: String(next) } : {}),
      });
    }
    throw new Error(`unexpected Inoreader request: ${method} ${url.pathname}${url.search}`);
  }

  get requests(): number {
    return this.calls.length;
  }
}

function assertParam(url: URL, name: string, value: string): void {
  if (url.searchParams.get(name) !== value) throw new Error(`expected ${name}=${value} in ${url.pathname}${url.search}`);
}

// --- Karakeep -----------------------------------------------------------------

export interface FakeBookmark {
  id: string;
  type?: "link" | "text" | "asset";
  url?: string;
  title?: string;
  html?: string;
  description?: string;
  crawlStatus?: "success" | "failure" | "pending";
  readerViewStatus?: "readable" | "not_readable" | "uncertain" | "unavailable" | null;
  createdAt?: string;
}

export class FakeKarakeep {
  bookmarks: FakeBookmark[] = [];
  pageSize = 2;
  calls: string[] = [];
  authHeaders = new Set<string>();
  status?: number;

  private bookmark(b: FakeBookmark, withContent: boolean) {
    const base = { id: b.id, createdAt: b.createdAt ?? "2026-01-02T03:04:05.000Z", archived: false, favourited: false, tags: [], assets: [] };
    if ((b.type ?? "link") !== "link") return { ...base, content: { type: b.type, text: "x" } };
    return {
      ...base,
      title: b.title ?? null,
      content: {
        type: "link",
        url: b.url,
        title: b.title ?? null,
        description: b.description ?? null,
        htmlContent: withContent ? b.html ?? null : null,
        crawlStatus: b.crawlStatus ?? "success",
        readerViewStatus: b.readerViewStatus === undefined ? "readable" : b.readerViewStatus,
        readerViewScore: 80,
        publisher: "Karakeep Publisher",
      },
    };
  }

  handle(url: URL, init?: RequestInit): Response {
    this.authHeaders.add(String((init?.headers as Record<string, string> | undefined)?.Authorization));
    if (this.status) return new Response("nope", { status: this.status });
    const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/bookmarks") {
      this.calls.push(`list ${url.searchParams.get("includeContent")}`);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = this.bookmarks.slice(start, start + this.pageSize);
      const next = start + this.pageSize;
      return json({ bookmarks: page.map((b) => this.bookmark(b, url.searchParams.get("includeContent") === "true")), nextCursor: next < this.bookmarks.length ? String(next) : null });
    }
    const m = url.pathname.match(/^\/api\/v1\/bookmarks\/([^/]+)$/);
    if (m) {
      this.calls.push(`get ${m[1]}`);
      const b = this.bookmarks.find((x) => x.id === m[1]);
      return b ? json(this.bookmark(b, url.searchParams.get("includeContent") === "true")) : new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected Karakeep request: ${url.pathname}`);
  }
}

/** Routes fetch to the fakes; returns a function that restores the real one. */
export function installFetch(ino: FakeInoreader, kk?: FakeKarakeep): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.host === "www.inoreader.com") return ino.handle(url, init);
    if (url.host === "karakeep.test" && kk) return kk.handle(url, init);
    throw new Error(`unexpected request to ${url.host}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export const para = (words: number, seed = "lorem"): string =>
  `<p>${Array.from({ length: words }, (_, i) => `${seed}${i % 13}`).join(" ")}.</p>`;

// --- a seeded index, for search and tool tests --------------------------------

export interface Seed {
  key: string;
  title: string;
  opening: string;
  text?: string | null;
  published?: number | null;
  source_title?: string;
  words?: number;
  headings?: string[];
  /** Names of the sources that hold it. */
  sources: string[];
  added_at?: number | null;
  highlights?: Highlight[];
}

/** An index over an in-memory store with these items already embedded (bag of words) and every source marked synced. */
export async function seededIndex(
  config: TasteConfig,
  seeds: Seed[],
  opts: { synced?: boolean; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
) {
  const { TasteIndex } = await import("../src/taste/index.js");
  const { TasteStore } = await import("../src/taste/store.js");
  const { META_SOURCES } = await import("../src/taste/sync.js");
  const { embedInput } = await import("../src/taste/text.js");
  const store = new TasteStore(":memory:", TasteStore.identityFor("fake", "fake"));
  const embedder = new FakeEmbedder();
  for (const s of seeds) {
    store.upsertItem({
      key: s.key, url: s.key, title: s.title, source_title: s.source_title ?? "Feed", published: s.published ?? null,
      opening: s.opening, headings: s.headings ?? [], words: s.words ?? s.opening.split(/\s+/).length, text: s.text ?? null, updated_at: 1,
    });
    s.sources.forEach((source, i) =>
      store.putSignal({ source, ext_id: `${source}:${s.key}`, key: s.key, fp: "", added_at: s.added_at ?? null, highlights: i === 0 ? s.highlights ?? [] : [] }),
    );
    store.putVector(s.key, "h", bagVector(embedInput(s.title, s.opening)));
  }
  if (opts.synced !== false) {
    store.setJson(META_SOURCES, Object.fromEntries(config.sources.map((s) => [s.name, { last_ok_at: "2026-01-01T00:00:00.000Z", last_error: null }])));
  }
  const index = new TasteIndex(
    { config, dataDir: "/nonexistent", dbPath: ":memory:", threads: 1 },
    { store, embedder, env: opts.env ?? {}, fetch: opts.fetch },
  );
  return { index, store, embedder };
}
