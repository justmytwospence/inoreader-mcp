import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "inoreader-workflows-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 }));
process.env.INOREADER_CONFIG_DIR = dir;
const { connect } = await import("./wire.js");
const { updateFromHeaders } = await import("../src/rate-limit.js");
after(() => rmSync(dir, { recursive: true, force: true }));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
function article(id: string) { return { id, title: `Article ${id}`, published: 1, categories: [], origin: { title: "Test", streamId: "feed/test", htmlUrl: "https://example.com" } }; }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }

test("saved union follows bounded pages and exposes partial counts, membership and continuations", async () => {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.searchParams.get("n"), "100");
    const next = !!url.searchParams.get("c");
    return json({ items: [article(next ? "2" : "1")], continuation: "next" });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "get_saved_items", arguments: { max_pages_per_collection: 2 } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(calls.length, 6);
    const data = r.structuredContent;
    assert.deepEqual(data, JSON.parse(r.content[0].text));
    assert.equal(data.items.length, 2); assert.equal(data.total_count, 2); assert.equal(data.complete, false);
    assert.deepEqual(data.items[0].saved_via, ["keep", "saved_web_page", "starred"]);
    for (const state of Object.values(data.collections) as any[]) { assert.equal(state.pages, 2); assert.equal(state.continuation, "next"); }
    calls.length = 0;
    const one = await request("tools/call", { name: "get_saved_items", arguments: {} });
    assert.equal(calls.length, 3); assert.equal(one.structuredContent.complete, false);
    assert.equal(one.structuredContent.total_count, 1);
  } finally { await server.close(); }
});

test("saved union labels unavailable collections as errors, never an empty complete account", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    return decodeURIComponent(String(input)).includes("/label/Keep") ? json({ error: "unavailable" }, 400) : json({ items: [article("1")] });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "get_saved_items", arguments: {} });
    assert.equal(calls, 3); assert.equal(r.isError, true); assert.equal(r.structuredContent.complete, false);
    assert.match(r.structuredContent.collections.keep.error, /400/);
    assert.equal(r.structuredContent.total_count, 1);
  } finally { await server.close(); }
});

test("IDs totals are honest one-page counts and structured results retain JSON text", async () => {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(new URL(String(input)));
    return json({ itemRefs: [{ id: "123" }], continuation: "after" });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const ids = await request("tools/call", { name: "get_article_ids", arguments: {} });
    assert.deepEqual(ids.structuredContent, { ids: ["123"], count: 1, continuation: "after" });
    assert.deepEqual(ids.structuredContent, JSON.parse(ids.content[0].text));
    const r = await request("tools/call", { name: "get_saved_web_pages", arguments: { count_only: true, continuation: "before" } });
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.total_is_exact, false); assert.equal(data.continuation, "after");
    assert.equal(calls[1].searchParams.get("c"), "before");
  } finally { await server.close(); }
});

test("invalid inputs fail before HTTP and advertised output schemas are present", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("invalid input must not fetch"); }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const { tools } = await request("tools/list");
    for (const name of ["get_article_ids", "get_saved_items", "categorize_feeds", "reassign_feeds", "batch_edit_subscriptions"]) {
      assert.equal(tools.find((t: any) => t.name === name).outputSchema?.type, "object");
    }
    for (const [name, args] of [
      ["get_articles", { since: "garbage" }], ["get_article_ids", { count: 1.5 }],
      ["get_saved_items", { max_pages_per_collection: 11 }], ["get_saved_items", { max_pages_per_collection: 0 }],
      ["list_subscriptions", { offset: -1 }], ["manage_tags", { article_ids: [] }],
      ["batch_edit_subscriptions", { edits: [] }], ["mark_all_read", { stream_id: "feed/x", before: "not-a-date" }],
    ] as const) {
      const r = await request("tools/call", { name, arguments: args });
      assert.equal(r.isError, true, name);
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test("verified bulk results satisfy their advertised wire output schema", async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls++;
    return init?.method === "POST" ? new Response("OK") : json({ subscriptions: [{ id: "feed/test", categories: [{ label: "New" }] }] });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "categorize_feeds", arguments: { assignments: { New: ["feed/test"] } } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(r.structuredContent.verified, 1);
    assert.equal(r.structuredContent.by_folder.New.verified, 1);
    assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text));
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test("expensive workflows and bulk writes preflight known budget before any account calls", async () => {
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "1", "x-reader-zone1-usage": "0", "x-reader-zone2-limit": "0", "x-reader-zone2-usage": "0", "x-reader-limits-reset-after": "3600" }));
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("budget must refuse before HTTP"); }) as typeof fetch;
  const { server, request } = await connect();
  try {
    for (const [name, args] of [
      ["get_saved_items", {}], ["analyze_feeds", {}], ["extract_classifier_data", {}],
      ["analyze_classifier_calibration", {}], ["recommend_audit_articles", {}],
      ["categorize_feeds", { assignments: { New: ["feed/test"] } }],
      ["manage_tags", { article_ids: ["123"], add_tag: "Keep" }],
      ["replace_feed", { stream_id: "feed/test", new_feed_url: "https://example.com/feed" }],
    ] as const) {
      const r = await request("tools/call", { name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /Insufficient Zone/);
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});
