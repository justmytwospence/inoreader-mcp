import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { FakeEmbedder, FakeInoreader, FakeKarakeep, cleanup, installFetch, para, setZone1 } from "./taste-fixtures.js";

// Zone 1 usage reported by Inoreader cannot be lowered inside its observation window,
// so these tests run in order from plenty of budget to none.

const { parseTasteConfig } = await import("../src/taste/config.js");
const { TasteStore } = await import("../src/taste/store.js");
const { runSync, META_LAST_SYNC } = await import("../src/taste/sync.js");

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
});
const ENV = { KK_URL: "http://karakeep.test", KK_KEY: "token-for-tests" };
const piece = (id: string, slug: string) => ({ id, url: `https://blog.example/${slug}`, title: `Piece ${slug}`, html: para(60, slug) });

function snapshot(store: InstanceType<typeof TasteStore>) {
  return JSON.stringify({
    items: store.allItems(),
    signals: [...store.signalsByKey()].sort(),
    vectors: [...store.vectorHashes()].sort(),
    counts: store.countsBySource(),
  });
}

test("a sync refused partway leaves the index exactly as it was", async () => {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [piece("1", "one"), piece("2", "two")]);
  ino.streams.set("user/-/label/Clip", [piece("1", "one")]);
  ino.annotated = [];
  const kk = new FakeKarakeep();
  restore = installFetch(ino, kk);
  setZone1(2000, 0);
  const store = new TasteStore(":memory:", TasteStore.identityFor("fake", "fake"));
  const embedder = new FakeEmbedder();

  const first = await runSync({ store, embedder, config, env: ENV });
  assert.equal(first.outcome, "ok", JSON.stringify(first));
  const before = snapshot(store);
  const embeddedBefore = embedder.embeddedCount;

  // 28 reads left: the preflight (2 ids + 1 annotations page + 25 reserve) passes, and the
  // content read for the new item then no longer fits.
  ino.streams.get("user/-/label/Archive")!.push(piece("3", "three"));
  kk.bookmarks = [{ id: "k1", url: "https://k.example/1", html: para(500), readerViewStatus: "readable" }];
  ino.calls.length = 0;
  kk.calls.length = 0;
  setZone1(2000, 1972);
  const r = await runSync({ store, embedder, config, env: ENV });

  assert.equal(r.outcome, "skipped");
  assert.match(r.reason!, /Insufficient Zone 1 budget for taste sync content: need 1 \+ 25 reserve/);
  assert.equal(r.z1_reads, 3, "the reads already made are reported");
  assert.equal(ino.calls.includes("POST contents"), false);
  assert.equal(kk.calls.length, 0, "Karakeep is not read either");
  assert.equal(snapshot(store), before, "items, signals and vectors are untouched");
  assert.equal(embedder.embeddedCount, embeddedBefore);
  assert.equal(store.getJson<{ outcome: string }>(META_LAST_SYNC, { outcome: "" }).outcome, "skipped");
});

test("a sync refused up front makes no request at all and says why", async () => {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [piece("1", "one")]);
  ino.streams.set("user/-/label/Clip", []);
  const kk = new FakeKarakeep();
  restore = installFetch(ino, kk);
  setZone1(2000, 1990);
  const store = new TasteStore(":memory:", TasteStore.identityFor("fake", "fake"));
  const embedder = new FakeEmbedder();
  const r = await runSync({ store, embedder, config, env: ENV });
  assert.equal(r.outcome, "skipped");
  assert.match(r.reason!, /Insufficient Zone 1 budget for taste sync: need 3 \+ 25 reserve/);
  assert.equal(ino.requests, 0);
  assert.equal(kk.calls.length, 0);
  assert.equal(r.z1_reads, 0);
  assert.equal(store.itemCount(), 0);
  assert.equal(embedder.embeddedCount, 0);
  assert.deepEqual(r.errors, []);
});
