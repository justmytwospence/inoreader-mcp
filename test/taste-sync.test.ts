import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import {
  FakeEmbedder, FakeInoreader, FakeKarakeep, cleanup, installFetch, para, setZone1, type FakeBookmark, type FakeItem,
} from "./taste-fixtures.js";

const { parseTasteConfig } = await import("../src/taste/config.js");
const { TasteStore } = await import("../src/taste/store.js");
const { runSync, retainsText, META_SOURCES } = await import("../src/taste/sync.js");
const { normalizeUrl } = await import("../src/taste/urls.js");

after(cleanup);
let restore = () => {};
afterEach(() => restore());

const ENV = { KARAKEEP_API_URL: "http://karakeep.test", KARAKEEP_API_KEY: "kk-test-token" };
const spencer = {
  sources: [
    { name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" },
    { name: "clip", type: "inoreader-stream", stream: "user/-/label/Clip" },
    { name: "highlights", type: "inoreader-annotations" },
    { name: "karakeep", type: "karakeep", url_env: "KARAKEEP_API_URL", key_env: "KARAKEEP_API_KEY", min_words: 300 },
  ],
  tiers: [
    { name: "clip", sources: ["clip"] },
    { name: "good", sources: ["clip", "highlights", "karakeep"] },
    { name: "archive", sources: ["*"] },
  ],
  default_tier: "good",
};
const config = parseTasteConfig(spencer);
const key = (url: string) => normalizeUrl(url)!;

const item = (id: string, slug: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  id, url: `https://blog.example/${slug}`, title: `Essay ${slug}`, html: `<h2>Part ${slug}</h2>${para(120, slug)}`, ...extra,
});
const A1 = item("1001", "a1");
const A2 = item("1002", "a2", { annotations: [{ id: 1, text: "a key sentence", note: "nice", added_on: 1_750_000_200 }, { id: 2, text: "another", added_on: 1_750_000_100 }] });
const A3 = item("1003", "post-3", { url: "https://www.example.com/post-3?utm_source=rss", html: "<p>Only a teaser of the post.</p>" });
const A4 = item("1004", "a4", { url: undefined });
const A5 = item("1005", "a5");
const C1 = item("1006", "c1");
const H1 = item("1007", "h1", { annotations: [{ id: 3, text: "h1 highlight", added_on: 1_750_000_300 }] });
const A6 = item("1008", "a6");

const bm = (id: string, extra: Partial<FakeBookmark>): FakeBookmark => ({ id, type: "link", ...extra });
const K1 = bm("k1", { url: "https://example.com/post-3/", title: "Post three in full", html: `<h2>Full</h2>${para(500, "kk")}`, readerViewStatus: "readable" });
const K2 = bm("k2", { url: "https://shop.example/item", html: para(900), readerViewStatus: "not_readable" });
const K3 = bm("k3", { url: "https://k.example/3", title: "Karakeep only", html: para(400, "kthree"), readerViewStatus: "uncertain" });
const K4 = bm("k4", { url: "https://k.example/4", html: para(50), readerViewStatus: "uncertain" });
const K5 = bm("k5", { type: "text" });
const K6 = bm("k6", { url: "https://k.example/6", html: para(350, "ksix"), crawlStatus: "pending", readerViewStatus: null });

function world() {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [A1, A2, A3, A4, A5]);
  ino.streams.set("user/-/label/Clip", [A1, C1]);
  ino.annotated = [A2, H1];
  const kk = new FakeKarakeep();
  kk.bookmarks = [K1, K2, K3, K4, K5, K6];
  const store = new TasteStore(":memory:", TasteStore.identityFor("fake", "fake"));
  const embedder = new FakeEmbedder();
  restore = installFetch(ino, kk);
  setZone1(2000, 0);
  const run = (cfg = config) => runSync({ store, embedder, config: cfg, env: ENV });
  return { ino, kk, store, embedder, run };
}

test("backfill: every source is read, URLs dedupe across sources, one vector per item", async () => {
  const { ino, kk, store, embedder, run } = world();
  const r = await run();
  assert.equal(r.outcome, "ok", JSON.stringify(r));
  assert.deepEqual(r.errors, []);

  // A1..A3, A5 (A4 has no URL), C1, H1, K3 (K1 is A3's twin).
  assert.equal(store.itemCount(), 7);
  assert.equal(store.vectorCount(), 7);
  assert.equal(r.items_added, 7);
  assert.equal(r.embedded, 7);
  assert.deepEqual(store.countsBySource(), { archive: 4, clip: 2, highlights: 2, karakeep: 2 });

  // The same page from a feed (tracking parameters, www) and from Karakeep is one row with two signals.
  const a3 = key("https://example.com/post-3");
  assert.deepEqual(store.signalsFor(a3).map((s) => s.source).sort(), ["archive", "karakeep"]);
  assert.ok(store.getItem(a3)!.words >= 500, "the teaser falls back to Karakeep's crawl");
  assert.equal(store.getItem(a3)!.title, "Post three in full");

  // The article with two signals is one item.
  assert.deepEqual(store.signalsFor(key(A1.url!)).map((s) => s.source).sort(), ["archive", "clip"]);

  // Items without a URL, not-readable bookmarks, short uncertain ones, text bookmarks and uncrawled ones are not indexed.
  assert.equal(store.getItem(key("https://shop.example/item")), undefined);
  assert.equal(store.getItem(key("https://k.example/4")), undefined);
  assert.equal(store.getItem(key("https://k.example/6")), undefined);
  assert.equal(store.signalsOf("archive").get("ino:" + BigInt(A4.id).toString(16))!.key, null);

  // Counted requests stay within the stated cost: 2 ids + 1 annotated page + 1 content POST.
  assert.equal(ino.requests, 4);
  assert.equal(r.z1_reads, 4);
  assert.ok(r.z1_reads <= 14);
  assert.deepEqual(ino.contentBodies, [["1001", "1003", "1004", "1005", "1006"]], "ids already read from the annotated stream are not fetched again");
  assert.equal([...kk.authHeaders].join(), "Bearer kk-test-token");
  assert.deepEqual(kk.calls.filter((c) => c.startsWith("get")).sort(), ["get k1", "get k3", "get k4"], "content only where the classifier or word count needs it");
  assert.equal(embedder.embeddedCount, 7);

  const state = store.getJson<Record<string, { last_ok_at: string | null }>>(META_SOURCES, {});
  assert.deepEqual(Object.keys(state).sort(), ["archive", "clip", "highlights", "karakeep"]);
  assert.ok(Object.values(state).every((s) => s.last_ok_at));
});

test("Karakeep: classifier first, word count only where it has no answer, and use_reader_view can turn it off", async () => {
  const { store, run } = world();
  await run();
  assert.ok(store.getItem(key("https://k.example/3")), "uncertain with 400 words is kept (min_words 300)");
  const strict = parseTasteConfig({
    ...spencer,
    sources: spencer.sources.map((s) => (s.type === "karakeep" ? { ...s, use_reader_view: false, min_words: 1000 } : s)),
  });
  const second = world();
  await second.run(strict);
  assert.equal(second.store.getItem(key("https://k.example/3")), undefined, "400 words is under 1000 when the classifier is ignored");
  assert.equal(second.store.getItem(key("https://shop.example/item")), undefined, "900 words is under 1000 even if the page was classified readable");
  const lenient = parseTasteConfig({
    ...spencer,
    sources: spencer.sources.map((s) => (s.type === "karakeep" ? { ...s, use_reader_view: false, min_words: 40 } : s)),
  });
  const third = world();
  await third.run(lenient);
  assert.ok(third.store.getItem(key("https://shop.example/item")), "the classifier no longer vetoes it");
  assert.ok(third.store.getItem(key("https://k.example/4")), "50 words clears min_words 40");
});

test("full text is kept for items in a narrower tier and dropped for items only in the widest", async () => {
  const { store, run } = world();
  await run();
  assert.ok(store.getItem(key(A1.url!))!.text, "clip");
  assert.ok(store.getItem(key(C1.url!))!.text, "clip");
  assert.ok(store.getItem(key(A2.url!))!.text, "highlights is in good");
  assert.ok(store.getItem(key("https://k.example/3"))!.text, "karakeep is in good");
  assert.equal(store.getItem(key(A5.url!))!.text, null, "archive only: the widest tier");
  assert.ok(store.getItem(key(A5.url!))!.opening.length > 0, "the opening is always kept");
  assert.deepEqual(store.getItem(key(A1.url!))!.headings, ["Part a1"]);
  assert.equal(retainsText(config, new Set(["archive"])), false);
  assert.equal(retainsText(config, new Set(["archive", "clip"])), true);
  assert.equal(retainsText(config, new Set()), false);
});

test("highlights keep their text, note and time, and the earliest time becomes the saved time", async () => {
  const { store, run } = world();
  await run();
  const sig = store.signalsFor(key(A2.url!)).find((s) => s.source === "highlights")!;
  assert.deepEqual(sig.highlights, [
    { id: "1", text: "a key sentence", note: "nice", added_on: 1_750_000_200 },
    { id: "2", text: "another", note: "", added_on: 1_750_000_100 },
  ]);
  assert.equal(sig.added_at, 1_750_000_100);
});

test("incremental: only new ids are fetched and only new items are embedded", async () => {
  const { ino, kk, store, embedder, run } = world();
  await run();
  ino.calls.length = 0;
  ino.contentBodies.length = 0;
  kk.calls.length = 0;
  embedder.calls.length = 0;

  ino.streams.get("user/-/label/Archive")!.push(A6);
  kk.bookmarks = kk.bookmarks.map((b) => (b.id === "k6" ? { ...b, crawlStatus: "success" as const, readerViewStatus: "readable" as const } : b));
  const r = await run();

  assert.equal(r.outcome, "ok");
  assert.deepEqual(ino.contentBodies, [["1008"]]);
  assert.equal(ino.requests, 4, "2 ids + 1 annotated page + 1 content POST");
  assert.deepEqual(kk.calls.filter((c) => c.startsWith("get")), ["get k6"], "only the bookmark that finished crawling is read");
  assert.equal(embedder.embeddedCount, 2);
  assert.equal(r.items_added, 2);
  assert.equal(store.itemCount(), 9);
  assert.equal(r.sources.archive.new_members, 1);
  assert.equal(r.sources.clip.new_members, 0);
});

test("a sync with nothing new reads listings only and embeds nothing", async () => {
  const { ino, kk, embedder, run } = world();
  await run();
  ino.calls.length = 0;
  ino.contentBodies.length = 0;
  kk.calls.length = 0;
  embedder.calls.length = 0;
  const r = await run();
  assert.equal(r.outcome, "ok");
  assert.deepEqual(ino.calls.sort(), ["GET annotated", "GET ids user/-/label/Archive", "GET ids user/-/label/Clip"]);
  assert.equal(r.z1_reads, 3);
  assert.equal(embedder.embeddedCount, 0);
  assert.equal(r.items_added, 0);
  assert.equal(r.embedded, 0);
  assert.deepEqual(kk.calls.filter((c) => c.startsWith("get")), []);
});

test("an untagged item loses that signal; an item with no signal left is deleted with its vector", async () => {
  const { ino, kk, store, run } = world();
  await run();

  ino.streams.set("user/-/label/Clip", [C1]); // A1 un-clipped, still in Archive
  ino.streams.set("user/-/label/Archive", [A1, A2, A3, A4]); // A5 removed: no other signal
  ino.annotated = [A2]; // H1 un-highlighted: no other signal
  kk.bookmarks = kk.bookmarks.filter((b) => b.id !== "k3"); // K3 deleted in Karakeep
  const r = await run();

  assert.equal(r.outcome, "ok");
  assert.deepEqual(store.signalsFor(key(A1.url!)).map((s) => s.source), ["archive"]);
  for (const gone of [A5.url!, H1.url!, "https://k.example/3"]) assert.equal(store.getItem(key(gone)), undefined, gone);
  assert.equal(r.items_removed, 3);
  assert.equal(store.itemCount(), 4);
  assert.equal(store.vectorCount(), 4);
  assert.deepEqual(store.countsBySource(), { archive: 3, clip: 1, highlights: 1, karakeep: 1 });
  assert.equal(r.sources.clip.removed_members, 1);
});

test("highlights added to an item already indexed are picked up", async () => {
  const { ino, store, run } = world();
  await run();
  ino.annotated = [{ ...A2, annotations: [...A2.annotations!, { id: 9, text: "later highlight", added_on: 1_760_000_000 }] }, H1];
  await run();
  const sig = store.signalsFor(key(A2.url!)).find((s) => s.source === "highlights")!;
  assert.equal(sig.highlights.length, 3);
  assert.ok(sig.highlights.some((h) => h.text === "later highlight"));
});

test("annotated items are paged until there is no continuation", async () => {
  const { ino, store, run } = world();
  ino.annotated = [A2, H1, item("1010", "h2"), item("1011", "h3"), item("1012", "h4")];
  ino.annotationPageSize = 2;
  const r = await run();
  assert.equal(ino.calls.filter((c) => c === "GET annotated").length, 3);
  assert.equal(store.countsBySource().highlights, 5);
  assert.equal(r.outcome, "ok");
});

test("a failing source keeps its stored members and is reported; the others still sync", async () => {
  const { ino, kk, store, run } = world();
  await run();
  assert.equal(store.countsBySource().karakeep, 2);

  kk.status = 401;
  ino.streams.get("user/-/label/Archive")!.push(A6);
  const r = await run();
  assert.equal(r.outcome, "partial");
  assert.equal(r.sources.karakeep.ok, false);
  assert.match(r.sources.karakeep.error!, /401/);
  assert.match(r.errors.join(" "), /karakeep: .*401/);
  assert.equal(store.countsBySource().karakeep, 2, "nothing was removed because Karakeep could not be listed");
  assert.ok(store.getItem(key(A6.url!)), "the Inoreader sources still applied");
  const state = store.getJson<Record<string, { last_error: string | null; last_ok_at: string | null }>>(META_SOURCES, {});
  assert.match(state.karakeep.last_error!, /401/);
  assert.ok(state.karakeep.last_ok_at, "its last good sync is remembered");

  kk.status = undefined;
  assert.equal((await run()).outcome, "ok");
  assert.equal(store.getJson<Record<string, { last_error: string | null }>>(META_SOURCES, {}).karakeep.last_error, null);
});

test("missing Karakeep settings fail only that source, naming the variables", async () => {
  const { store, embedder } = world();
  const r = await runSync({ store, embedder, config, env: {} });
  assert.equal(r.outcome, "partial");
  assert.match(r.sources.karakeep.error!, /KARAKEEP_API_URL, KARAKEEP_API_KEY/);
  assert.equal(store.countsBySource().archive, 4);
});

test("an Inoreader error on one stream fails that source only", async () => {
  const { ino, store, run } = world();
  ino.failIds = 400; // every ids read fails; 4xx is not retried
  const r = await run();
  assert.equal(r.outcome, "partial");
  assert.equal(r.sources.archive.ok, false);
  assert.equal(r.sources.clip.ok, false);
  assert.equal(r.sources.highlights.ok, true);
  assert.equal(r.sources.karakeep.ok, true);
  assert.equal(store.countsBySource().highlights, 2);
});

test("a stream cut off at the ids limit removes nothing", async () => {
  const { ino, store, run } = world();
  await run();
  ino.truncated = true;
  ino.streams.set("user/-/label/Archive", [A1, A2]);
  const r = await run();
  assert.equal(r.sources.archive.removed_members, 0);
  assert.ok(store.getItem(key(A5.url!)));
  const state = store.getJson<Record<string, { note?: string }>>(META_SOURCES, {});
  assert.match(state.archive.note!, /incomplete/);
});

test("when the model cannot load, items are stored without vectors and the next sync embeds them", async () => {
  const { ino, store, embedder, run } = world();
  embedder.failWith = "model files missing";
  const r1 = await run();
  assert.equal(r1.outcome, "partial");
  assert.match(r1.errors.join(" "), /embedding: model files missing/);
  assert.equal(store.itemCount(), 7);
  assert.equal(store.vectorCount(), 0);

  embedder.failWith = undefined;
  ino.contentBodies.length = 0;
  const r2 = await run();
  assert.equal(r2.outcome, "ok");
  assert.equal(r2.embedded, 7);
  assert.equal(store.vectorCount(), 7);
  assert.deepEqual(ino.contentBodies, [], "nothing is read again to embed what was stored");
});

test("a changed title or opening is re-embedded; an unchanged one is not", async () => {
  const { ino, embedder, store, run } = world();
  await run();
  embedder.calls.length = 0;
  // Longer text wins over the stored copy, so an edited article is picked up...
  ino.annotated = [{ ...A2, html: `<p>Reworked intro.</p>${para(200, "new")}` }, H1];
  await run();
  assert.equal(embedder.embeddedCount, 1);
  assert.match(store.getItem(key(A2.url!))!.opening, /Reworked intro/);
  // ...and a shorter feed copy does not flip it back.
  embedder.calls.length = 0;
  ino.annotated = [A2, H1];
  await run();
  assert.equal(embedder.embeddedCount, 0);
  assert.match(store.getItem(key(A2.url!))!.opening, /Reworked intro/);
});

test("sources dropped from the config are pruned with the items only they held", async () => {
  const { store, run } = world();
  await run();
  assert.ok(store.getItem(key("https://k.example/3")));
  const without = parseTasteConfig({
    sources: spencer.sources.filter((s) => s.name !== "karakeep"),
    tiers: [{ name: "clip", sources: ["clip"] }, { name: "archive", sources: ["*"] }],
  });
  await run(without);
  assert.equal(store.getItem(key("https://k.example/3")), undefined);
  assert.ok(store.getItem(key("https://example.com/post-3")), "still in the Archive stream");
  assert.deepEqual(Object.keys(store.countsBySource()).sort(), ["archive", "clip", "highlights"]);
});

test("a default-config sync reads starred and highlights", async () => {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/state/com.google/starred", [A1, A5]);
  ino.annotated = [A2];
  restore = installFetch(ino);
  setZone1(2000, 0);
  const store = new TasteStore(":memory:", TasteStore.identityFor("fake", "fake"));
  const cfg = (await import("../src/taste/config.js")).loadTasteConfig({});
  const r = await runSync({ store, embedder: new FakeEmbedder(), config: cfg });
  assert.equal(r.outcome, "ok");
  assert.deepEqual(store.countsBySource(), { starred: 2, highlights: 1 });
  assert.equal(ino.requests, 3);
});
