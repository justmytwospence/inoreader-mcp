import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TasteStore, type ItemRow, type SignalRow } from "../src/taste/store.js";

const dir = mkdtempSync(join(tmpdir(), "taste-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ID = TasteStore.identityFor("model-a", "q8");

const item = (key: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  key, url: key, title: `Title ${key}`, source_title: "Feed", published: 1_700_000_000, opening: "opening", headings: ["H"], words: 10, text: "full text", updated_at: 1, ...extra,
});
const sig = (source: string, ext: string, key: string | null, extra: Partial<SignalRow> = {}): SignalRow => ({
  source, ext_id: ext, key, fp: "", added_at: null, highlights: [], ...extra,
});

test("items round-trip and upsert replaces", () => {
  const s = new TasteStore(":memory:", ID);
  s.upsertItem(item("https://a.example/1"));
  s.upsertItem(item("https://a.example/1", { title: "Changed", headings: ["X", "Y"], text: null }));
  assert.equal(s.itemCount(), 1);
  const got = s.getItem("https://a.example/1")!;
  assert.equal(got.title, "Changed");
  assert.deepEqual(got.headings, ["X", "Y"]);
  assert.equal(got.text, null);
  assert.equal(s.getItem("https://nope"), undefined);
});

test("signals: several sources on one item, counts by source, tier queries", () => {
  const s = new TasteStore(":memory:", ID);
  for (const k of ["k1", "k2", "k3"]) s.upsertItem(item(k));
  s.putSignal(sig("archive", "ino:1", "k1"));
  s.putSignal(sig("archive", "ino:2", "k2"));
  s.putSignal(sig("clip", "ino:1", "k1"));
  s.putSignal(sig("highlights", "ino:3", "k3", { highlights: [{ id: "9", text: "t", note: "n", added_on: 5 }], added_at: 5 }));
  assert.deepEqual(s.countsBySource(), { archive: 2, clip: 1, highlights: 1 });
  assert.deepEqual([...s.keysForSources(["clip", "highlights"])].sort(), ["k1", "k3"]);
  assert.deepEqual([...s.keysForSources(["archive", "clip", "highlights"])].sort(), ["k1", "k2", "k3"]);
  assert.deepEqual(s.signalsFor("k3")[0].highlights, [{ id: "9", text: "t", note: "n", added_on: 5 }]);
  assert.equal(s.signalsByKey().get("k1")!.length, 2);
});

test("members judged not indexable are remembered but never count", () => {
  const s = new TasteStore(":memory:", ID);
  s.putSignal(sig("kk", "kk:1", null, { fp: "success|not_readable" }));
  assert.equal(s.signalsOf("kk").get("kk:1")!.key, null);
  assert.deepEqual(s.countsBySource(), {});
  assert.deepEqual(s.keyOfExtId("kk:1"), { key: null });
  assert.equal(s.keyOfExtId("kk:none"), undefined);
});

test("keyOfExtId prefers a resolved key over a skip recorded elsewhere", () => {
  const s = new TasteStore(":memory:", ID);
  s.putSignal(sig("a", "ino:1", null));
  s.putSignal(sig("b", "ino:1", "k1"));
  assert.deepEqual(s.keyOfExtId("ino:1"), { key: "k1" });
});

test("removing the last signal and collecting deletes the item and its vector", () => {
  const s = new TasteStore(":memory:", ID);
  s.upsertItem(item("k1"));
  s.upsertItem(item("k2"));
  s.putVector("k1", "h", new Float32Array([1, 0]));
  s.putVector("k2", "h", new Float32Array([0, 1]));
  s.putSignal(sig("archive", "ino:1", "k1"));
  s.putSignal(sig("clip", "ino:1", "k1"));
  s.putSignal(sig("archive", "ino:2", "k2"));
  assert.equal(s.gc(), 0);
  s.deleteSignals("clip", ["ino:1"]);
  assert.equal(s.gc(), 0, "k1 still has its archive signal");
  s.deleteSignals("archive", ["ino:2"]);
  assert.equal(s.gc(), 1);
  assert.equal(s.getItem("k2"), undefined);
  assert.ok(s.getItem("k1"));
  assert.deepEqual([...s.vectorHashes().keys()], ["k1"]);
});

test("pruneSources drops signals of sources no longer configured", () => {
  const s = new TasteStore(":memory:", ID);
  s.upsertItem(item("k1"));
  s.putSignal(sig("old", "ino:1", "k1"));
  s.putSignal(sig("kept", "ino:2", "k1"));
  assert.equal(s.pruneSources(["kept"]), 1);
  assert.deepEqual(Object.keys(s.countsBySource()), ["kept"]);
});

test("vectors round-trip as Float32 in a stable key order", () => {
  const s = new TasteStore(":memory:", ID);
  s.putVector("b", "h1", Float32Array.from([0.25, -0.5, 0.125]));
  s.putVector("a", "h2", Float32Array.from([1, 2, 3]));
  s.putVector("a", "h3", Float32Array.from([4, 5, 6])); // replaced
  const m = s.loadMatrix();
  assert.deepEqual(m.keys, ["a", "b"]);
  assert.equal(m.dims, 3);
  assert.deepEqual([...m.data], [4, 5, 6, 0.25, -0.5, 0.125]);
  assert.equal(s.vectorHashes().get("a"), "h3");
  assert.deepEqual(new TasteStore(":memory:", ID).loadMatrix(), { keys: [], dims: 0, data: new Float32Array(0) });
});

test("a failed transaction leaves nothing behind", () => {
  const s = new TasteStore(":memory:", ID);
  assert.throws(() => s.transaction(() => {
    s.upsertItem(item("k1"));
    throw new Error("boom");
  }), /boom/);
  assert.equal(s.itemCount(), 0);
  s.transaction(() => s.upsertItem(item("k2")));
  assert.equal(s.itemCount(), 1);
});

test("meta values and JSON round-trip, with a fallback for garbage", () => {
  const s = new TasteStore(":memory:", ID);
  s.setJson("x", { a: [1, 2] });
  assert.deepEqual(s.getJson("x", null), { a: [1, 2] });
  assert.equal(s.getJson("missing", 7), 7);
  s.setMeta("bad", "{not json");
  assert.deepEqual(s.getJson("bad", { ok: true }), { ok: true });
});

test("data persists across opens with the same identity", () => {
  const file = join(dir, "persist.sqlite");
  const a = new TasteStore(file, ID);
  assert.equal(a.rebuilt, false);
  a.upsertItem(item("k1"));
  a.putSignal(sig("s", "e", "k1"));
  a.close();
  const b = new TasteStore(file, ID);
  assert.equal(b.rebuilt, false);
  assert.equal(b.itemCount(), 1);
  assert.equal(b.signalsOf("s").size, 1);
  b.close();
});

test("a changed identity (model or dtype) resets the index", () => {
  const file = join(dir, "identity.sqlite");
  const a = new TasteStore(file, ID);
  a.upsertItem(item("k1"));
  a.putVector("k1", "h", new Float32Array([1]));
  a.setMeta("note", "x");
  a.close();
  for (const other of [TasteStore.identityFor("model-b", "q8"), TasteStore.identityFor("model-b", "fp32")]) {
    const b = new TasteStore(file, other);
    assert.equal(b.rebuilt, true);
    assert.equal(b.itemCount(), 0);
    assert.equal(b.vectorCount(), 0);
    assert.equal(b.getMeta("note"), null);
    assert.equal(b.getMeta("identity"), other);
    b.close();
  }
});

test("a corrupt file is replaced by a working empty index", () => {
  const file = join(dir, "corrupt.sqlite");
  writeFileSync(file, "this is not a sqlite database, it is just some bytes".repeat(100));
  const s = new TasteStore(file, ID);
  assert.equal(s.rebuilt, true);
  assert.equal(s.itemCount(), 0);
  s.upsertItem(item("k1"));
  assert.equal(s.itemCount(), 1);
  s.close();
  assert.ok(existsSync(file));
  const again = new TasteStore(file, ID);
  assert.equal(again.rebuilt, false);
  assert.equal(again.itemCount(), 1);
  again.close();
});
