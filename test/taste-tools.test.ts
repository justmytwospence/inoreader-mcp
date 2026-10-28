import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { FakeInoreader, cleanup, dir, installFetch, para, seededIndex, setZone1 } from "./taste-fixtures.js";

const { connect } = await import("./wire.js");
const { parseTasteConfig } = await import("../src/taste/config.js");
const { TasteIndex, resetTasteIndex } = await import("../src/taste/index.js");

after(async () => {
  await resetTasteIndex();
  cleanup();
});
let restore = () => {};
afterEach(async () => {
  restore();
  restore = () => {};
  delete process.env.INOREADER_TASTE_INDEX;
  await resetTasteIndex();
});

const TASTE_TOOLS = ["similar_saved", "check_novelty", "taste_index_status", "sync_taste_index"];
const config = parseTasteConfig({
  sources: [
    { name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" },
    { name: "highlights", type: "inoreader-annotations" },
  ],
  tiers: [{ name: "highlights", sources: ["highlights"] }, { name: "everything", sources: ["*"] }],
  default_tier: "everything",
});
const seeds = [
  { key: "https://x.example/one", title: "Partial pooling explained", opening: "hierarchical models partial pooling shrinkage", sources: ["archive", "highlights"], highlights: [{ id: "1", text: "borrow strength", note: "", added_on: 1_750_000_000 }] },
  { key: "https://x.example/two", title: "Sourdough", opening: "flour water starter crust", sources: ["archive"] },
];

async function enable() {
  process.env.INOREADER_TASTE_INDEX = "on";
  const made = await seededIndex(config, seeds);
  await resetTasteIndex(made.index);
  return made;
}

const call = async (request: (m: string, p?: Record<string, unknown>) => Promise<any>, name: string, args: Record<string, unknown> = {}) => {
  const result = await request("tools/call", { name, arguments: args });
  return { result, value: result.isError ? null : JSON.parse(result.content[0].text) };
};

test("without INOREADER_TASTE_INDEX=on the taste tools do not exist", async () => {
  const { server, request } = await connect();
  try {
    const { tools } = await request("tools/list");
    for (const name of TASTE_TOOLS) assert.ok(!tools.some((t: any) => t.name === name), name);
  } finally {
    await server.close();
  }
});

test("with the index on, the four tools are listed with all four hints and the configured tier names", async () => {
  await enable();
  const { server, request } = await connect();
  try {
    const { tools } = await request("tools/list");
    const taste = tools.filter((t: any) => TASTE_TOOLS.includes(t.name));
    assert.deepEqual(taste.map((t: any) => t.name).sort(), [...TASTE_TOOLS].sort());
    for (const t of taste) {
      assert.deepEqual(t.annotations, {
        readOnlyHint: t.name !== "sync_taste_index",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: t.name === "sync_taste_index",
      }, t.name);
      assert.match(t.description, /inoreader:\/\/usage/);
      assert.match(t.description, /Costs/);
      assert.equal(t.inputSchema.type, "object");
    }
    const similar = taste.find((t: any) => t.name === "similar_saved");
    assert.deepEqual(similar.inputSchema.properties.prefer.enum, ["highlights", "everything"]);
    assert.match(similar.description, /highlights \(highlights\); then everything \(archive, highlights\)/);
    assert.equal(similar.inputSchema.properties.k.maximum, 20);
    assert.equal(similar.inputSchema.properties.excerpt_chars.minimum, 100);
    assert.equal(similar.inputSchema.properties.excerpt_chars.maximum, 4000);
    assert.deepEqual(similar.inputSchema.required, ["text"]);
    assert.deepEqual(taste.find((t: any) => t.name === "check_novelty").inputSchema.required, ["idea"]);
    assert.match(taste.find((t: any) => t.name === "check_novelty").description, /0\.75/);
  } finally {
    await server.close();
  }
});

test("similar_saved, check_novelty and taste_index_status answer from the local index", async () => {
  await enable();
  const { server, request } = await connect();
  try {
    const sim = await call(request, "similar_saved", { text: "hierarchical models with partial pooling", k: 1, prefer: "highlights", min_similarity: 0 });
    assert.deepEqual(sim.result.structuredContent, sim.value);
    assert.equal(sim.value.results[0].title, "Partial pooling explained");
    assert.equal(sim.value.results[0].highlights[0].text, "borrow strength");
    assert.equal(sim.value.coverage.complete, true);

    const nov = await call(request, "check_novelty", { idea: "partial pooling hierarchical models shrinkage", threshold: 0.5 });
    assert.equal(nov.value.verdict, "close");
    assert.equal(nov.value.nearest[0].url, "https://x.example/one");

    const status = await call(request, "taste_index_status");
    assert.equal(status.value.counts.items, 2);
    assert.deepEqual(status.value.config.tiers.map((t: any) => t.name), ["highlights", "everything"]);
  } finally {
    await server.close();
  }
});

test("a tier that is not configured is rejected, and the bounds are enforced", async () => {
  await enable();
  const { server, request } = await connect();
  try {
    for (const args of [
      { text: "x", prefer: "archive" },
      { text: "x", k: 21 },
      { text: "x", excerpt_chars: 99 },
      { text: "x", min_similarity: 1.5 },
      { text: "" },
    ]) {
      const outcome = await request("tools/call", { name: "similar_saved", arguments: args }).then((r) => r, (e) => ({ isError: true, error: String(e) }));
      assert.equal(outcome.isError, true, JSON.stringify(args));
    }
  } finally {
    await server.close();
  }
});

test("sync_taste_index runs a sync and reports reads and coverage", async () => {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [{ id: "3001", url: "https://x.example/three", title: "Third", html: para(60, "third") }]);
  ino.annotated = [];
  restore = installFetch(ino);
  setZone1(2000, 0);
  process.env.INOREADER_TASTE_INDEX = "on";
  const made = await seededIndex(config, []);
  await resetTasteIndex(made.index);
  const { server, request } = await connect();
  try {
    const { value } = await call(request, "sync_taste_index");
    assert.equal(value.outcome, "ok");
    assert.equal(value.z1_reads, 3, "one ids read, one annotations page, one content read");
    assert.equal(value.items_added, 1);
    assert.equal(value.coverage.complete, true);
  } finally {
    await server.close();
  }
});

test("createServer stays free of side effects: building servers opens no store and loads no model", async () => {
  process.env.INOREADER_TASTE_INDEX = "on";
  const dataDir = join(dir, "taste-lazy");
  const index = new TasteIndex({ config, dataDir, dbPath: join(dataDir, "index.sqlite"), threads: 1 });
  await resetTasteIndex(index);
  for (let i = 0; i < 3; i++) {
    const { server, request } = await connect();
    await request("tools/list");
    await server.close();
  }
  assert.equal(existsSync(dataDir), false, "the index file is created on first use, not at registration");
  assert.equal((index as unknown as { _store?: unknown })._store, undefined);
  assert.equal((index as unknown as { _embedder?: unknown })._embedder, undefined);
});
