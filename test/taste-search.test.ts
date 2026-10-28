import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DIMS, FakeEmbedder, FakeInoreader, bagVector, cleanup, installFetch, para, seededIndex, setZone1 } from "./taste-fixtures.js";

const { parseTasteConfig } = await import("../src/taste/config.js");
const { nearest, scoreAll, similar, tiersOf, excerptOf } = await import("../src/taste/search.js");
const { embedInput } = await import("../src/taste/text.js");

after(cleanup);
let restore = () => {};
afterEach(() => restore());

const config = parseTasteConfig({
  sources: [
    { name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" },
    { name: "clip", type: "inoreader-stream", stream: "user/-/label/Clip" },
    { name: "highlights", type: "inoreader-annotations" },
    { name: "karakeep", type: "karakeep", url_env: "KK_URL", key_env: "KK_KEY" },
  ],
  tiers: [
    { name: "clip", sources: ["clip"] },
    { name: "good", sources: ["clip", "highlights", "karakeep"] },
    { name: "archive", sources: ["*"] },
  ],
  default_tier: "good",
  novelty_threshold: 0.75,
});

const SHARED = "bayesian hierarchical models partial pooling shrinkage estimates groups";
const seeds = [
  { key: "https://x.example/clip", title: "Clipped essay", opening: `${SHARED} clipped`, text: "The full text of the clipped essay. ".repeat(40), sources: ["clip", "archive"], published: 1_700_000_000, added_at: 1_750_000_000 },
  { key: "https://x.example/karakeep", title: "Karakeep page", opening: `${SHARED} karakeep extra words here`, sources: ["karakeep"], added_at: 1_751_000_000 },
  { key: "https://x.example/archive-best", title: "Archive best match", opening: SHARED, sources: ["archive"] },
  { key: "https://x.example/archive-ok", title: "Archive other", opening: `${SHARED} plus many unrelated filler words about cooking and travel`, sources: ["archive"] },
  {
    key: "https://x.example/highlighted", title: "Highlighted piece", opening: `${SHARED} highlighted`, sources: ["highlights", "archive"], added_at: 1_752_000_000,
    highlights: [{ id: "1", text: "pooling borrows strength", note: "key idea", added_on: 1_752_000_000 }],
  },
  { key: "https://x.example/unrelated", title: "Sourdough", opening: "flour water starter oven crust bread dough", sources: ["archive"] },
];

const embedText = (s: { title: string; opening: string }) => embedInput(s.title, s.opening);

test("tiers: an item's tiers follow its signals, narrowest first", () => {
  assert.deepEqual(tiersOf(config, new Set(["clip", "archive"])), ["clip", "good", "archive"]);
  assert.deepEqual(tiersOf(config, new Set(["karakeep"])), ["good", "archive"]);
  assert.deepEqual(tiersOf(config, new Set(["archive"])), ["archive"]);
  assert.deepEqual(tiersOf(config, undefined), []);
});

test("similar: the preferred tier comes first, wider tiers fill the rest", async () => {
  const { index } = await seededIndex(config, seeds);
  const r = await index.similar({ text: SHARED, k: 5, prefer: "clip", min_similarity: 0 });
  assert.equal(r.results[0].url, "https://x.example/clip", "the only clip item leads even though other items match better");
  assert.equal(r.results[0].tier, "clip");
  assert.deepEqual(r.results[0].tiers, ["clip", "good", "archive"]);
  assert.equal(r.results.length, 5);
  const rest = r.results.slice(1).map((x) => x.similarity);
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a), "the rest are ordered by similarity");
  assert.ok(r.results.slice(1).every((x) => x.url !== "https://x.example/clip"));
});

test("similar: prefer 'good' draws from clip, highlights and karakeep before archive-only items", async () => {
  const { index } = await seededIndex(config, seeds);
  const r = await index.similar({ text: SHARED, k: 6, prefer: "good", min_similarity: 0 });
  const urls = r.results.map((x) => x.url);
  const good = new Set(["https://x.example/clip", "https://x.example/karakeep", "https://x.example/highlighted"]);
  assert.deepEqual(new Set(urls.slice(0, 3)), good);
  assert.ok(!urls.slice(0, 3).includes("https://x.example/archive-best"));
  assert.equal(urls[3], "https://x.example/archive-best");
  assert.equal(r.prefer, "good");
});

test("similar: the default tier comes from the configuration", async () => {
  const { index } = await seededIndex(config, seeds);
  const r = await index.similar({ text: SHARED, k: 3, min_similarity: 0 });
  assert.equal(r.prefer, "good");
  assert.ok(r.results.every((x) => x.tiers.includes("good")));
});

test("similar: min_similarity drops weak matches, and k bounds the count", async () => {
  const { index } = await seededIndex(config, seeds);
  const all = await index.similar({ text: SHARED, k: 20, prefer: "archive", min_similarity: 0 });
  assert.equal(all.results.length, seeds.length);
  const strict = await index.similar({ text: SHARED, k: 20, prefer: "archive", min_similarity: 0.5 });
  assert.ok(strict.results.length < all.results.length);
  assert.ok(strict.results.every((x) => x.similarity >= 0.5));
  assert.ok(!strict.results.some((x) => x.url.endsWith("unrelated")));
  assert.equal((await index.similar({ text: SHARED, k: 2, prefer: "archive", min_similarity: 0 })).results.length, 2);
});

test("similar: an unknown tier is refused, naming the configured ones", async () => {
  const { index } = await seededIndex(config, seeds);
  await assert.rejects(index.similar({ text: "x", prefer: "best" }), /Unknown tier "best".*clip, good, archive/);
});

test("similar: results carry dates, signals, headings, word count and highlights", async () => {
  const withMeta = seeds.map((s) => (s.key.endsWith("/highlighted") ? { ...s, headings: ["Why pooling", "Shrinkage"], words: 1234, published: 1_700_000_000 } : s));
  const { index } = await seededIndex(config, withMeta);
  const r = await index.similar({ text: `${SHARED} highlighted`, k: 1, prefer: "good", min_similarity: 0 });
  const hit = r.results[0];
  assert.equal(hit.title, "Highlighted piece");
  assert.deepEqual(hit.signals, ["archive", "highlights"], "in the order the sources are configured");
  assert.equal(hit.tier, "good");
  assert.equal(hit.published, "2023-11-14T22:13:20.000Z");
  assert.equal(hit.saved, new Date(1_752_000_000 * 1000).toISOString());
  assert.deepEqual(hit.headings, ["Why pooling", "Shrinkage"]);
  assert.equal(hit.words, 1234);
  assert.deepEqual(hit.highlights, [{ text: "pooling borrows strength", note: "key idea", added_on: new Date(1_752_000_000 * 1000).toISOString() }]);
  assert.equal(typeof hit.similarity, "number");
});

test("similar: the excerpt is the stored text when there is one, else the opening, cut at the requested length", async () => {
  const { index } = await seededIndex(config, seeds);
  const r = await index.similar({ text: `${SHARED} clipped`, k: 6, prefer: "clip", min_similarity: 0, excerpt_chars: 100 });
  const clip = r.results.find((x) => x.url.endsWith("/clip"))!;
  assert.ok(clip.excerpt.startsWith("The full text of the clipped essay."));
  assert.ok(clip.excerpt.length <= 103);
  assert.ok(clip.excerpt.endsWith("..."));
  const archive = r.results.find((x) => x.url.endsWith("/archive-best"))!;
  assert.equal(archive.excerpt, SHARED, "no stored text: the opening, whole when it fits");
  const long = await index.similar({ text: `${SHARED} clipped`, k: 1, prefer: "clip", min_similarity: 0, excerpt_chars: 4000 });
  assert.ok(long.results[0].excerpt.length > 800);
  assert.equal(excerptOf("short", 100), "short");
});

test("novelty: at the threshold counts as close, just under it as novel", async () => {
  const { index, embedder, store } = await seededIndex(config, seeds.slice(0, 1));
  const item = new Float32Array(DIMS);
  item[0] = 1;
  embedder.table.set(embedText(seeds[0]), item);
  const at = new Float32Array(DIMS);
  at[0] = 0.75;
  at[1] = Math.sqrt(1 - 0.75 * 0.75);
  embedder.table.set("an idea at exactly the threshold", at);
  const below = new Float32Array(DIMS);
  below[0] = 0.74;
  below[1] = Math.sqrt(1 - 0.74 * 0.74);
  embedder.table.set("an idea just under", below);
  store.putVector(seeds[0].key, "h", item); // the exact vector, not the bag of words

  const close = await index.novelty({ idea: "an idea at exactly the threshold" });
  assert.equal(close.verdict, "close");
  assert.equal(close.threshold, 0.75);
  assert.equal(close.nearest[0].similarity, 0.75);
  assert.equal((await index.novelty({ idea: "an idea just under" })).verdict, "novel");
  assert.equal((await index.novelty({ idea: "an idea just under", threshold: 0.7 })).verdict, "close", "the threshold is a parameter");
  assert.equal((await index.novelty({ idea: "an idea at exactly the threshold", threshold: 0.8 })).verdict, "novel");
});

test("novelty: returns the nearest items from any tier with similarity, and says similarity is not quality", async () => {
  const { index } = await seededIndex(config, seeds);
  const r = await index.novelty({ idea: SHARED, k: 3 });
  assert.equal(r.nearest.length, 3);
  assert.equal(r.nearest[0].url, "https://x.example/archive-best", "an archive-only item is found: novelty looks across all tiers");
  assert.equal(r.verdict, "close");
  assert.match(r.note, /not the quality/);
  assert.ok(r.nearest.every((n, i, a) => i === 0 || a[i - 1].similarity >= n.similarity));
  const unrelated = await index.novelty({ idea: "quantum chromodynamics lattice gauge theory" });
  assert.equal(unrelated.verdict, "novel");
});

test("an empty or unsynced index reports its coverage instead of pretending", async () => {
  const { index } = await seededIndex(config, [], { synced: false });
  const s = await index.similar({ text: "anything" });
  assert.deepEqual(s.results, []);
  assert.equal(s.coverage.complete, false);
  assert.equal(s.coverage.sources_synced, "0/4");
  assert.deepEqual(s.coverage.unsynced_sources, ["archive", "clip", "highlights", "karakeep"]);
  assert.match(s.coverage.note!, /still building/);
  const n = await index.novelty({ idea: "anything" });
  assert.equal(n.verdict, "novel");
  assert.match(n.note, /empty/);
  assert.equal(n.coverage.items_indexed, 0);
});

test("coverage is complete once every source has synced and every item has a vector", async () => {
  const { index, store } = await seededIndex(config, seeds);
  assert.equal(index.coverage().complete, true);
  assert.equal(index.coverage().items_indexed, seeds.length);
  assert.equal(index.coverage().sources_synced, "4/4");
  store.upsertItem({ ...store.getItem(seeds[0].key)!, key: "https://x.example/no-vector" });
  assert.equal(index.coverage().complete, false, "an item without a vector is not searchable yet");
});

test("search primitives: scores are dot products, and a query of the wrong size is refused", () => {
  const data = Float32Array.from([1, 0, 0, 1]);
  const snap = { keys: ["a", "b"], dims: 2, data, owners: new Map([["a", new Set(["archive"])], ["b", new Set(["clip"])]]) };
  assert.deepEqual([...scoreAll(snap, Float32Array.from([0.6, 0.8]))].map((x) => Math.round(x * 10) / 10), [0.6, 0.8]);
  assert.throws(() => scoreAll(snap, Float32Array.from([1])), /1 dimensions but the index has 2/);
  assert.deepEqual(nearest(snap, config, Float32Array.from([0, 1]), 1).map((h) => h.key), ["b"]);
  assert.deepEqual(similar(snap, config, Float32Array.from([0, 1]), { prefer: "archive", k: 5, minSimilarity: 0.5 }).map((h) => h.key), ["b"]);
});

test("status reports sources, tiers and counts, and never the Karakeep secrets", async () => {
  const env = { KK_URL: "http://karakeep.internal.example:3000", KK_KEY: "super-secret-value-123" };
  const { index } = await seededIndex(config, seeds, { env });
  const status = index.status();
  const text = JSON.stringify(status);
  assert.ok(!text.includes("super-secret-value-123"));
  assert.ok(!text.includes("karakeep.internal.example"));
  assert.equal(status.enabled, true);
  assert.deepEqual(status.config.tiers.map((t) => t.name), ["clip", "good", "archive"]);
  const kk = status.config.sources.find((s) => s.name === "karakeep") as { credentials_set: boolean; url_env: string; key_env: string };
  assert.deepEqual([kk.credentials_set, kk.url_env, kk.key_env], [true, "KK_URL", "KK_KEY"]);
  assert.equal(status.counts.items, seeds.length);
  assert.deepEqual(status.counts.by_source, { archive: 5, clip: 1, highlights: 1, karakeep: 1 });
  assert.deepEqual(status.counts.by_tier, { clip: 1, good: 3, archive: 6 });
  assert.equal(status.coverage.complete, true);
  assert.equal(status.sync.running, false);
  assert.equal(status.sync.z1_reads.expected_per_sync, 3, "two stream sources and one annotations page");
  assert.match(status.sync.z1_reads.cost_model, /25 Zone 1 reads in reserve/);
  const unset = (await seededIndex(config, [], { env: {} })).index.status();
  assert.equal((unset.config.sources.find((s) => s.name === "karakeep") as { credentials_set: boolean }).credentials_set, false);
});

test("a sync joins one already running, and searches see its results afterwards", async () => {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [{ id: "2001", url: "https://x.example/new", title: "New piece", html: para(80, "fresh") }]);
  ino.streams.set("user/-/label/Clip", []);
  restore = installFetch(ino);
  setZone1(2000, 0);
  const small = parseTasteConfig({
    sources: [
      { name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" },
      { name: "clip", type: "inoreader-stream", stream: "user/-/label/Clip" },
    ],
  });
  const { index } = await seededIndex(small, []);
  assert.equal((await index.similar({ text: "fresh0 fresh1 fresh2", min_similarity: 0 })).results.length, 0);
  const [a, b] = [index.sync(), index.sync()];
  assert.equal(a, b, "the same in-flight promise");
  const report = await a;
  assert.equal(report.outcome, "ok");
  assert.equal(ino.contentBodies.length, 1);
  const after = await index.similar({ text: "fresh0 fresh1 fresh2", min_similarity: 0 });
  assert.equal(after.results[0].title, "New piece");
  assert.equal(after.coverage.complete, true);
  // A finished sync is not joined by the next one.
  assert.notEqual(index.sync(), a);
  await index.sync();
});

test("bagVector embeds shared words closer than unrelated ones (the fake behaves)", () => {
  const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
  assert.ok(dot(bagVector("pooling shrinkage models"), bagVector("pooling models")) > dot(bagVector("pooling shrinkage models"), bagVector("bread dough")));
  assert.equal(new FakeEmbedder().model, "fake");
});
