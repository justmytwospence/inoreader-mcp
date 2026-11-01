import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { labelType } from "../src/labels.js";

const dir = mkdtempSync(join(tmpdir(), "inoreader-labels-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 }));
process.env.INOREADER_CONFIG_DIR = dir;
const { connect } = await import("./wire.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });

test("label types preserve folders, searches, states and unknowns without inventing engagement tags", () => {
  const folders = new Set(["user/-/label/Topic"]);
  for (const type of ["folder", "tag", "active_search"] as const) assert.equal(labelType({ id: "user/-/label/Test", type }), type);
  assert.equal(labelType({ id: "user/-/label/Topic" }, folders), "folder");
  assert.equal(labelType({ id: "user/-/label/Topic", type: "active_search" }, folders), "active_search");
  assert.equal(labelType({ id: "user/-/state/com.google/starred" }), "state");
  assert.equal(labelType({ id: "user/-/label/Mystery" }), "unknown");
  assert.equal(labelType({ id: "user/-/label/Mystery", type: "unexpected" }), "unknown");
});

test("folder/tag tool requests types and never defaults untyped labels to tag", async () => {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url);
    const data = url.pathname.endsWith("tag/list") ? { tags: [
      { id: "user/-/label/Empty folder", type: "folder" },
      { id: "user/-/label/Search", type: "active_search" },
      { id: "user/-/label/Unknown" },
    ] } : { unreadcounts: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const result = await request("tools/call", { name: "list_folders_and_tags", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.items.map((x: any) => x.type), ["folder", "active_search", "unknown"]);
    assert.equal(calls.length, 2);
    const tagCall = calls.find((u) => u.pathname.endsWith("tag/list"))!;
    assert.equal(tagCall.searchParams.get("types"), "1");
    assert.equal(tagCall.searchParams.get("counts"), "1");
  } finally { await server.close(); }
});

test("folder resource recognizes empty typed folders and preserves active searches", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith("tag/list") ? { tags: [
      { id: "user/-/label/Empty", type: "folder" }, { id: "user/-/label/Legacy" },
      { id: "user/-/label/Search", type: "active_search" }, { id: "user/-/label/Unknown" },
    ] } : { subscriptions: [{ id: "feed/legacy", categories: [{ id: "user/-/label/Legacy", label: "Legacy" }] }] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const result = await request("resources/read", { uri: "inoreader://folders" });
    const data = JSON.parse(result.contents[0].text);
    assert.equal(data.total_folders, 2);
    assert.deepEqual(data.folders.map((x: any) => [x.label, x.feed_count]), [["Empty", 0], ["Legacy", 1]]);
    assert.deepEqual(data.tags.map((x: any) => x.type), ["active_search", "unknown"]);
  } finally { await server.close(); }
});
