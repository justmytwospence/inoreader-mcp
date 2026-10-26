import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "inoreader-analysis-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 }));
process.env.INOREADER_CONFIG_DIR = dir;
const { connect } = await import("./wire.js");
const { updateFromHeaders } = await import("../src/rate-limit.js");
after(() => rmSync(dir, { recursive: true, force: true }));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }

test("analysis bounds aggregate base requests and discloses unscanned engagement", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("subscription/list")) return json({ subscriptions: [] });
    if (path.endsWith("unread-count")) return json({ unreadcounts: [] });
    if (path.endsWith("tag/list")) return json({ tags: [{ id: "user/-/label/Engaged" }] });
    throw new Error("max_requests=3 must stop after metadata");
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "analyze_feeds", arguments: { max_requests: 3 } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(calls, 3);
    assert.equal(r.structuredContent.summary.has_more_engaged, true);
    assert.match(r.structuredContent.summary.degraded.join(" "), /NOT evidence of no engagement/);
    assert.match(r.structuredContent.summary.cost_basis, /retries are extra/);
  } finally { await server.close(); }
});

test("classifier cap flags distinguish a full final page from true remaining continuation", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("summaries"), "1", "reads existing summaries, no creation endpoint");
    return json({ items: [] });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    let r = await request("tools/call", { name: "extract_classifier_data", arguments: { include_population: true, population_pages: 1 } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(calls, 5);
    assert.equal(r.structuredContent.summary.population_hit_cap, false);
    assert.equal(r.structuredContent.summary.verified_hit_cap, false);
    assert.equal(r.structuredContent.summary.api_cost_z1, 5);
    calls = 0;
    globalThis.fetch = (async (input: unknown) => {
      calls++;
      return json({ items: [], ...(decodeURIComponent(String(input)).includes("/label/read/worth-it") ? { continuation: "next" } : {}) });
    }) as typeof fetch;
    r = await request("tools/call", { name: "extract_classifier_data", arguments: {} });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(calls, 23, "one 20-page stream plus three single-page streams");
    assert.equal(r.structuredContent.summary.verified_hit_cap, true);
  } finally { await server.close(); }
});

test("classifier stream errors do not masquerade as a complete empty dataset", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return json({ error: "missing label" }, 400); }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "extract_classifier_data", arguments: {} });
    assert.equal(r.isError, true); assert.equal(calls, 1);
    assert.match(r.content[0].text, /could not be read/);
  } finally { await server.close(); }
});

test("analysis leaves a known 25-request reserve before engagement reads", async () => {
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "28", "x-reader-zone1-usage": "0", "x-reader-limits-reset-after": "3600" }));
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    const path = new URL(String(input)).pathname;
    return json(path.endsWith("subscription/list") ? { subscriptions: [] } : path.endsWith("unread-count") ? { unreadcounts: [] } : { tags: [{ id: "user/-/label/Engaged" }] });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const r = await request("tools/call", { name: "analyze_feeds", arguments: {} });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(calls, 3);
    assert.equal(r.structuredContent.summary.has_more_engaged, true);
    assert.ok(r.structuredContent.summary.degraded.length);
  } finally { await server.close(); }
});
