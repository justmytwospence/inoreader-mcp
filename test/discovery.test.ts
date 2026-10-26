import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "inoreader-discovery-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 }));
process.env.INOREADER_CONFIG_DIR = dir;
const { connect } = await import("./wire.js");
after(() => rmSync(dir, { recursive: true, force: true }));
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const promptNames = ["triage-unread", "feed-health-review", "organize-uncategorized", "summarize-recent", "analyze-classifier", "review-saved-web-pages"];

test("initialize, discovery, static guide, status and every prompt need zero HTTP", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("discovery must not fetch"); }) as typeof fetch;
  const { server, request, initialized } = await connect();
  try {
    assert.match(initialized.instructions, /Zone 1/);
    assert.match(initialized.instructions, /ambiguous write/);
    for (const capability of ["tools", "resources", "prompts"]) assert.ok(initialized.capabilities[capability]);
    const { resources } = await request("resources/list");
    assert.deepEqual(resources.map((r: any) => r.uri).sort(), ["usage", "rate-limits", "subscriptions", "folders", "unread-counts"].map((r) => `inoreader://${r}`).sort());
    const { resourceTemplates } = await request("resources/templates/list");
    assert.deepEqual(resourceTemplates.map((t: any) => t.uriTemplate), ["inoreader://articles/{article_id}/content?max_chars={max_chars}"]);
    const { prompts } = await request("prompts/list");
    assert.deepEqual(prompts.map((p: any) => p.name).sort(), [...promptNames].sort());
    const guide = (await request("resources/read", { uri: "inoreader://usage" })).contents[0].text;
    for (const name of promptNames) assert.ok(guide.includes(name));
    for (const example of ["inoreader://articles/123/content?max_chars=8000", "tag%3Agoogle.com%2C2005%3Areader%2Fitem%2F00000000499602d2"]) assert.ok(guide.includes(example));
    assert.match(guide, /3 times max_pages_per_collection/);
    assert.match(guide, /list_folders_and_tags costs 2/);
    const status = await request("resources/read", { uri: "inoreader://rate-limits" });
    assert.match(status.contents[0].text, /unknown/);
    const toolStatus = await request("tools/call", { name: "get_rate_limit_status", arguments: {} });
    assert.deepEqual(toolStatus.structuredContent, JSON.parse(toolStatus.content[0].text));
    for (const name of promptNames) {
      const p = await request("prompts/get", { name, arguments: {} });
      const text = p.messages[0].content.text;
      assert.match(text, /get_rate_limit_status/);
      assert.match(text, /inoreader:\/\/usage/);
      assert.match(text, /no HTTP, writes or paid processing/);
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test("prompt arguments reject nonsense and instructions use actual tool inputs", async () => {
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
  const { server, request } = await connect();
  try {
    for (const [name, args] of [
      ["triage-unread", { count: "101" }], ["triage-unread", { count: "2.5" }],
      ["summarize-recent", { hours: "NaN" }], ["feed-health-review", { months: "0" }],
      ["analyze-classifier", { bins: "1000" }], ["analyze-classifier", { breakdown_by: "garbage" }],
    ] as const) await assert.rejects(request("prompts/get", { name, arguments: args }));
    const triage = await request("prompts/get", { name: "triage-unread", arguments: { count: "5", folder: "Tech" } });
    assert.match(triage.messages[0].content.text, /stream_id .*count 5, include_total=false/);
    const health = await request("prompts/get", { name: "feed-health-review", arguments: {} });
    assert.match(health.messages[0].content.text, /ONE analyze_feeds/);
    assert.doesNotMatch(health.messages[0].content.text, /calls in parallel/);
  } finally { await server.close(); }
});

test("article resource validates URI and bounds content without extraction or writes", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    assert.equal(calls.at(-1), "POST /reader/api/0/stream/items/contents");
    assert.ok(["123", "tag:google.com,2005:reader/item/000000000000007b"].includes(new URLSearchParams(init?.body as URLSearchParams).get("i")!));
    return new Response(JSON.stringify({ items: [{ id: "123", title: "Test", published: 1, summary: { content: "x".repeat(30000) } }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    for (const uri of [
      "inoreader://articles/not-an-id/content?max_chars=32", "inoreader://articles/123/content", "inoreader://articles/123/content?max_chars=0",
      "inoreader://articles/123/content?max_chars=20001", "inoreader://articles/123/content?max_chars=1.5",
      "inoreader://articles/123/content?max_chars=2&max_chars=3", "inoreader://articles/123/content?paid=true",
      "inoreader://articles/123/content?max_chars=Infinity", "inoreader://articles/123/content?max_chars=-1",
    ]) await assert.rejects(request("resources/read", { uri }));
    assert.equal(calls.length, 0, "validation must precede API/auth calls");
    const r = await request("resources/read", { uri: "inoreader://articles/123/content?max_chars=32" });
    const data = JSON.parse(r.contents[0].text);
    assert.equal(data.content.length, 32);
    assert.equal(data.content_truncated, true);
    assert.equal(data.content_chars_available, 30000);
    assert.equal(data.provenance.base_cost_zone1, 1);
    await request("resources/read", { uri: "inoreader://articles/123/content?max_chars=8000" });
    const encoded = await request("resources/read", { uri: "inoreader://articles/tag%3Agoogle.com%2C2005%3Areader%2Fitem%2F000000000000007b/content?max_chars=32" });
    assert.equal(JSON.parse(encoded.contents[0].text).id, "123");
    assert.equal(calls.length, 3);
  } finally { await server.close(); }
});

test("existing live metadata resources have honest costs and bounded output", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const subscriptions = Array.from({ length: 501 }, (_, i) => ({ id: `feed/${i}`, title: `Feed ${i}`, url: "https://example.com/rss", htmlUrl: "https://example.com", categories: [{ id: "user/-/label/Test", label: "Test" }] }));
    const data = path.endsWith("subscription/list") ? { subscriptions } : path.endsWith("tag/list") ? { tags: [{ id: "user/-/label/Test" }] } : { unreadcounts: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const data = JSON.parse((await request("resources/read", { uri: "inoreader://subscriptions" })).contents[0].text);
    assert.equal(data.total, 501); assert.equal(data.subscriptions.length, 500); assert.equal(data.truncated, true);
    const before = calls.length;
    await request("resources/read", { uri: "inoreader://folders" });
    assert.equal(calls.length - before, 2);
    await request("resources/read", { uri: "inoreader://unread-counts" });
    assert.equal(calls.length, 4);
  } finally { await server.close(); }
});
