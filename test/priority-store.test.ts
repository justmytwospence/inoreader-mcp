import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  atomicJson, emptyDecisions, listSnapshots, profileDir, readDecisions, readSnapshot,
  saveDecisions, saveSnapshot, withProfileLock, type PrioritySnapshot,
} from "../src/priority/store.js";

async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "priority-store-"));
  const previous = process.env.INOREADER_CONFIG_DIR;
  process.env.INOREADER_CONFIG_DIR = dir;
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); }
    finally {
      if (previous === undefined) delete process.env.INOREADER_CONFIG_DIR;
      else process.env.INOREADER_CONFIG_DIR = previous;
    }
  });
  return dir;
}

const snapshot = (overrides: Partial<PrioritySnapshot> = {}): PrioritySnapshot => ({
  version: 1,
  id: "checkpoint-1",
  config_hash: "a".repeat(64),
  model: "category-beta-v1",
  started_at: 100,
  completed_at: null,
  cutoff: 50,
  phase: "signals",
  source_index: 1,
  feed_index: 0,
  continuation: "opaque-next-page",
  base_reads: 3,
  subscriptions: [{
    id: "feed/one", title: "One", categories: [{ id: "user/-/label/News", label: "News" }],
    url: "https://example.com/feed", htmlUrl: "https://example.com/",
  }],
  signal_sources: ["user/-/label/Archive", "user/-/state/com.google/starred"],
  source_coverage: { "user/-/label/Archive": true, "user/-/state/com.google/starred": false },
  signals: { "feed/one": [{ id: "article-1", timestamp: 75 }] },
  feed_ids: ["feed/one"],
  volumes: { "feed/one": { articles: [{ id: "article-1", timestamp: 75 }], complete: false, observed_at: null } },
  prospective: { "feed/one": { articles: [{ id: "article-1", timestamp: 75 }], first_observed: 100, gap_blocked: true } },
  membership: ["feed/one"],
  errors: ["previous page unavailable"],
  ...overrides,
});

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

test("atomic JSON writes and replacements are private and leave no temporary files", async t => {
  const dir = await stateDir(t);
  const path = join(dir, "nested", "state.json");
  const original = { version: 1, values: ["old"] };
  await atomicJson(path, original);
  assert.deepEqual(await json(path), original);
  assert.equal(await mode(path), 0o600);
  assert.equal(await mode(join(dir, "nested")), 0o700);
  await chmod(path, 0o644);
  await atomicJson(path, { version: 2, values: ["new"] });
  assert.deepEqual(await json(path), { version: 2, values: ["new"] });
  assert.equal(await mode(path), 0o600, "replacement must not inherit an insecure old mode");
  assert.deepEqual(await readdir(join(dir, "nested")), ["state.json"]);
});

test("concurrent atomic replacements expose only complete JSON documents", async t => {
  const dir = await stateDir(t);
  const path = join(dir, "state.json");
  const values = Array.from({ length: 9 }, (_, version) => ({ version, payload: String(version).repeat(8192) }));
  await atomicJson(path, values[0]);
  await Promise.all([
    ...values.slice(1).map(value => atomicJson(path, value)),
    (async () => {
      for (let i = 0; i < 30; i++) {
        const value = await json(path) as typeof values[number];
        assert.deepEqual(value, values[value.version]);
      }
    })(),
  ]);
  const final = await json(path) as typeof values[number];
  assert.deepEqual(final, values[final.version]);
  assert.equal(await mode(path), 0o600);
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("failed atomic writes preserve committed state and clean temporary files", async t => {
  const dir = await stateDir(t);
  const path = join(dir, "state.json");
  await atomicJson(path, { committed: true });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(atomicJson(path, circular), /circular/i);
  assert.deepEqual(await json(path), { committed: true });
  await mkdir(join(dir, "not-a-file"));
  await assert.rejects(atomicJson(join(dir, "not-a-file"), { value: 1 }));
  assert.deepEqual((await readdir(dir)).sort(), ["not-a-file", "state.json"]);
});

test("only a pristine profile or an empty snapshot directory gets fresh decisions", async t => {
  await stateDir(t);
  assert.deepEqual(await readDecisions("fresh"), emptyDecisions());
  await assert.rejects(stat(profileDir("fresh")), { code: "ENOENT" });
  await mkdir(join(profileDir("fresh"), "snapshots"), { recursive: true });
  assert.deepEqual(await readDecisions("fresh"), emptyDecisions());
  assert.deepEqual(await listSnapshots("fresh"), []);
  const first = emptyDecisions();
  first.preferences["feed/one"] = { pin: true, exclude: false, history: [] };
  assert.deepEqual(emptyDecisions().preferences, {}, "fresh state must not share mutable containers");
});

test("decisions round-trip preferences, observations, membership, intents, and migrations privately", async t => {
  await stateDir(t);
  const state = emptyDecisions();
  state.active_snapshot = "checkpoint-1";
  state.latest_snapshot = "checkpoint-2";
  state.preferences["feed/one"] = {
    pin: true, exclude: false,
    history: [{ action: "pin", reason: "reviewed", at: 100, config_hash: "hash", snapshot_id: "checkpoint-1" }],
  };
  state.observations["feed/one"] = {
    first_observed: 75, last_complete: null, gap_blocked: true, articles: [{ id: "article-1", timestamp: 75 }],
  };
  state.membership = { at: 100, ids: ["feed/one"], since: { "feed/one": 75 } };
  state.intents.push({
    id: "intent-1", reason: "calibrated promotion", config_hash: "hash", original_topic_ids: [],
    stream_id: "feed/one", action: "auto_add", at: 100, week: "2026-W01",
    snapshot_id: "checkpoint-1", status: "unverified", error: "verification pending",
  });
  state.migrations.push({ old_id: "feed/old", new_id: "feed/one", at: 100, status: "pending" });
  await saveDecisions("reading", state);
  assert.deepEqual(await readDecisions("reading"), state);
  assert.equal(await mode(join(profileDir("reading"), "decisions.json")), 0o600);
});

test("malformed decision state fails closed without resetting or overwriting bytes", async t => {
  await stateDir(t);
  const dir = profileDir("reading");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "decisions.json");
  const invalid = [
    "{not JSON", "null", "{}",
    JSON.stringify({ ...emptyDecisions(), version: 2 }),
    JSON.stringify({ ...emptyDecisions(), preferences: { "feed/one": { pin: "true", exclude: false, history: [] } } }),
    JSON.stringify({ ...emptyDecisions(), membership: { at: -1, ids: [], since: {} } }),
  ];
  for (const bytes of invalid) {
    await writeFile(path, bytes);
    await assert.rejects(readDecisions("reading"), /Priority state unavailable or corrupt .*refusing to reset/);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("missing decisions beside even an incomplete snapshot fail closed", async t => {
  await stateDir(t);
  const dir = profileDir("reading");
  await mkdir(join(dir, "snapshots", "unfinished"), { recursive: true });
  await assert.rejects(readDecisions("reading"), /Missing priority decisions beside existing snapshots; refusing reset/);
  await assert.rejects(stat(join(dir, "decisions.json")), { code: "ENOENT" });
});

test("invalid saves reject before replacing valid decisions or snapshot checkpoints", async t => {
  await stateDir(t);
  const state = emptyDecisions();
  const checkpoint = snapshot();
  await saveDecisions("reading", state);
  await saveSnapshot("reading", checkpoint);
  await assert.rejects(saveDecisions("reading", { ...state, version: 2 } as unknown as typeof state));
  await assert.rejects(saveSnapshot("reading", { ...checkpoint, source_index: -1 }));
  assert.deepEqual(await readDecisions("reading"), state);
  assert.deepEqual(await readSnapshot("reading", checkpoint.id), checkpoint);
});

test("missing and corrupt snapshot manifests fail closed, including during listing", async t => {
  await stateDir(t);
  await assert.rejects(readSnapshot("reading", "missing"), /Priority state unavailable or corrupt .*refusing to reset/);
  const checkpoint = snapshot();
  await saveSnapshot("reading", checkpoint);
  const path = join(profileDir("reading"), "snapshots", checkpoint.id, "manifest.json");
  for (const bytes of ["{broken", "{}", JSON.stringify({ ...checkpoint, continuation: 12 }), JSON.stringify({ ...checkpoint, phase: "unknown" })]) {
    await writeFile(path, bytes);
    await assert.rejects(readSnapshot("reading", checkpoint.id), /refusing to reset/);
    await assert.rejects(listSnapshots("reading", { include_ids: [checkpoint.id] }), /refusing to reset/);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("profile locks serialize concurrent read-modify-write calls without blocking other profiles", async t => {
  await stateDir(t);
  await saveDecisions("reading", emptyDecisions());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: number[] = [];
  const updates = Array.from({ length: 8 }, (_, index) => withProfileLock("reading", async () => {
    order.push(index);
    if (index === 0) { entered.resolve(); await release.promise; }
    const state = await readDecisions("reading");
    state.preferences[`feed/${index}`] = { pin: true, exclude: false, history: [] };
    await saveDecisions("reading", state);
    return index;
  }));
  try {
    await entered.promise;
    assert.equal(await withProfileLock("other", async () => "independent"), "independent");
    assert.deepEqual(order, [0], "queued calls must not enter while the first holds the lock");
  } finally {
    release.resolve();
    await Promise.all(updates);
  }
  assert.deepEqual(await Promise.all(updates), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(Object.keys((await readDecisions("reading")).preferences).length, 8);
});

test("a rejected profile operation does not poison queued or later calls", async t => {
  await stateDir(t);
  const order: string[] = [];
  const failure = new Error("failed operation");
  const first = withProfileLock("reading", async () => { order.push("failed"); throw failure; });
  const rejected = assert.rejects(first, error => error === failure);
  const second = withProfileLock("reading", async () => { order.push("queued"); return 2; });
  await rejected;
  assert.equal(await second, 2);
  assert.equal(await withProfileLock("reading", async () => { order.push("later"); return 3; }), 3);
  assert.deepEqual(order, ["failed", "queued", "later"]);
});

test("snapshot cursor and accumulated evidence survive a process restart; orphan shards cannot advance it", async t => {
  await stateDir(t);
  const checkpoint = snapshot();
  await saveSnapshot("reading", checkpoint);
  const state = { ...emptyDecisions(), latest_snapshot: checkpoint.id };
  await saveDecisions("reading", state);
  const dir = join(profileDir("reading"), "snapshots", checkpoint.id);
  const signalsHash = createHash("sha256").update(JSON.stringify(checkpoint.signals)).digest("hex");
  const volume = { stream_id: "feed/one", ...checkpoint.volumes["feed/one"] };
  const volumeHash = createHash("sha256").update(JSON.stringify(volume)).digest("hex");
  for (const [path, value] of [
    [join(dir, "signals", `${signalsHash}.json`), checkpoint.signals],
    [join(dir, "feeds", `${volumeHash}.json`), volume],
    [join(dir, "manifest.json"), checkpoint],
  ] as const) {
    assert.deepEqual(await json(path), value);
    assert.equal(await mode(path), 0o600);
  }
  // A crash after writing a shard but before committing the manifest must replay the old cursor.
  await atomicJson(join(dir, "signals", `${"f".repeat(64)}.json`), { uncommitted: [{ id: "article-2", timestamp: 80 }] });
  const restart = async () => {
    const moduleUrl = new URL("../src/priority/store.js", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { readSnapshot, readDecisions } from ${JSON.stringify(moduleUrl)};
      const decisions = await readDecisions("reading");
      const checkpoint = await readSnapshot("reading", decisions.latest_snapshot);
      process.stdout.write(JSON.stringify({ decisions, checkpoint }));
    `], { env: { ...process.env } });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await restart(), { decisions: state, checkpoint });
  const immutablePath = join(dir, "feeds", `${volumeHash}.json`);
  const immutableBefore = await stat(immutablePath);
  const next = snapshot({
    phase: "volumes", source_index: 2, feed_index: 1, continuation: "next-volume-page", base_reads: 5,
    signals: { "feed/one": [...checkpoint.signals["feed/one"], { id: "article-2", timestamp: 80 }] },
  });
  await saveSnapshot("reading", next);
  const immutableAfter = await stat(immutablePath);
  assert.equal(immutableAfter.ino, immutableBefore.ino, "unchanged volume shard must not be rewritten/renamed");
  assert.equal(immutableAfter.mtimeMs, immutableBefore.mtimeMs);
  assert.deepEqual(await restart(), { decisions: state, checkpoint: next });
  assert.deepEqual(await json(join(dir, "signals", `${signalsHash}.json`)), checkpoint.signals, "old content-addressed shard stays intact");
});

test("snapshot working set picks newest completed snapshot in each UTC week deterministically", async t => {
  await stateDir(t);
  for (const [id, started_at] of [["z", 8 * 86400000], ["b", 100], ["a", 100]] as const) {
    await saveSnapshot("reading", snapshot({ id, started_at, phase: "complete", completed_at: started_at + 1 }));
  }
  assert.deepEqual((await listSnapshots("reading")).map(item => item.id), ["b", "z"]);
  assert.deepEqual((await listSnapshots("reading", { include_ids: ["a"] })).map(item => item.id), ["a", "b", "z"]);
});

test("old corrupt archive manifests outside eight-week working set are not loaded, but explicit reads fail closed", async t => {
  await stateDir(t);
  for (let i = 0; i < 12; i++) {
    const started_at = Date.UTC(2026, 0, 5) + i * 7 * 86400000;
    await saveSnapshot("bounded", snapshot({ id: `week-${i}`, started_at, completed_at: started_at + 1, phase: "complete" }));
  }
  const path = join(profileDir("bounded"), "snapshots", "week-0", "manifest.json");
  await writeFile(path, "{corrupt archived large manifest");
  const recent = await listSnapshots("bounded");
  assert.equal(recent.length, 8); assert.equal(recent[0].id, "week-4"); assert.equal(recent.at(-1)?.id, "week-11");
  await assert.rejects(readSnapshot("bounded", "week-0"), /refusing to reset/);
  await assert.rejects(listSnapshots("bounded", { include_ids: ["week-0"] }), /refusing to reset/);
});

test("unsafe profile names and snapshot ids cannot escape the scoped state directory", async t => {
  await stateDir(t);
  for (const name of ["../escape", "a/b", "", "UPPER"]) assert.throws(() => profileDir(name), /Unsafe profile name/);
  for (const id of ["../escape", "a/b", "", "x".repeat(101)]) {
    await assert.rejects(readSnapshot("reading", id), /Unsafe snapshot id/);
    await assert.rejects(saveSnapshot("reading", snapshot({ id })));
  }
});
