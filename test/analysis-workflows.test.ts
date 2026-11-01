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

test("classifier calibration stabilizes unanimous labels without changing interior or empty priors", async () => {
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "10000", "x-reader-zone1-usage": "0", "x-reader-limits-reset-after": "3600" }));
  let labels: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("summaries"), "1");
    const path = decodeURIComponent(url.pathname);
    const label = path.endsWith("/label/read/not-worth-it") ? "not-worth-it"
      : path.endsWith("/label/read/worth-it") ? "worth-it" : null;
    return json({ items: labels.flatMap((value, i) => value === label ? [{
      ...article(`calibration-${i}`),
      summaries: [{ summary: "RECOMMENDATION: read CONFIDENCE: 70" }],
    }] : []) });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    for (const fixture of [
      { labels: ["worth-it", "worth-it"], rate: 0.8333, alpha: 3.3333, beta: 0.6667, stabilized: true },
      { labels: ["not-worth-it", "not-worth-it"], rate: 0.1667, alpha: 0.6667, beta: 3.3333, stabilized: true },
      { labels: ["worth-it", "not-worth-it", "not-worth-it"], rate: 0.3333, alpha: 1.3333, beta: 2.6667, stabilized: false },
      { labels: [], rate: 0.5, alpha: 2, beta: 2, stabilized: false },
    ]) {
      labels = fixture.labels;
      const r = await request("tools/call", { name: "analyze_classifier_calibration", arguments: { bins: 2, prior_strength: 4, breakdown_by: ["feed"], refresh: true } });
      assert.notEqual(r.isError, true, JSON.stringify(r));
      const { calibration, precision, by_feed } = r.structuredContent;
      assert.equal(calibration.total_n, labels.length);
      assert.deepEqual(calibration.prior, { alpha: fixture.alpha, beta: fixture.beta, rate: fixture.rate, strength: 4, boundary_stabilized: fixture.stabilized });
      if (labels.length) assert.equal(by_feed["feed/a"].prior.boundary_stabilized, fixture.stabilized);
      for (const row of [...calibration.bins, precision]) {
        for (const key of ["posterior_mean", "ci_low", "ci_high"]) assert.ok(Number.isFinite(row[key]), `${key}: ${JSON.stringify(row)}`);
        assert.ok(row.ci_low <= row.ci_high);
      }
    }
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

const subscription = (id: string, folders = ["Topic"]) => ({ id, title: id, categories: folders.map((label) => ({ id: `user/-/label/${label}`, label })), url: id, htmlUrl: "" });
const article = (id: string, feed = "feed/a") => ({ id, origin: { streamId: feed }, timestampUsec: String(Date.now() * 1000), categories: [] });

async function analyzeFixture(
  options: Record<string, unknown>,
  fixture: { subscriptions?: ReturnType<typeof subscription>[]; tags?: Array<{ id: string; type?: string }>; stream?: (id: string, url: URL) => unknown; volume?: (url: URL) => unknown },
) {
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "10000", "x-reader-zone1-usage": "0", "x-reader-limits-reset-after": "3600" }));
  const urls: URL[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET", "analysis never writes");
    const url = new URL(String(input)); urls.push(url);
    const path = url.pathname;
    if (path.endsWith("subscription/list")) return json({ subscriptions: fixture.subscriptions ?? [subscription("feed/a")] });
    if (path.endsWith("unread-count")) return json({ unreadcounts: [{ id: "feed/a", count: 1, newestItemTimestampUsec: String(Date.now() * 1000) }] });
    if (path.endsWith("tag/list")) { assert.equal(url.searchParams.get("types"), "1"); return json({ tags: fixture.tags ?? [{ id: "user/-/state/com.google/starred" }] }); }
    if (path.endsWith("stream/items/ids")) { const result = fixture.volume?.(url) ?? { itemRefs: [] }; return result instanceof Response ? result : json(result); }
    if (path.includes("/stream/contents/")) { const result = fixture.stream?.(decodeURIComponent(path.split("/stream/contents/")[1]), url) ?? { items: [article("a")] }; return result instanceof Response ? result : json(result); }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    const result = await request("tools/call", { name: "analyze_feeds", arguments: options });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return { result: result.structuredContent, urls };
  } finally { await server.close(); }
}

test("analysis follows volume continuations and deduplicates positive-stream membership", async () => {
  const { result, urls } = await analyzeFixture({ engagement_streams: ["user/-/state/com.google/starred", "user/-/label/Saved"], max_requests: 7 }, {
    tags: [{ id: "user/-/state/com.google/starred" }, { id: "user/-/label/Saved", type: "tag" }],
    stream: () => ({ items: [article("a"), article("b")] }),
    volume: (url) => url.searchParams.has("c") ? { itemRefs: [{ id: "2" }, { id: "3" }] } : { itemRefs: [{ id: "1" }, { id: "2" }], continuation: "next" },
  });
  assert.equal(urls.length, 7);
  assert.equal(urls.at(-1)?.searchParams.get("c"), "next");
  assert.equal(result.summary.engaged_articles_scanned, 2);
  const row = result.feeds[0];
  assert.equal(row.engaged_count, 2); assert.equal(row.total_articles, 3);
  assert.equal(row.volume_complete, true); assert.equal(row.engagement_complete, true);
  assert.equal(row.retention_adjusted, false);
  assert.ok(row.posterior_alpha > 0 && row.posterior_beta > 0 && row.ci_low > 0 && row.ci_high < 1);
});

test("explicit positive allowlists exclude negative/automation labels, folders, and active searches", async () => {
  const { result, urls } = await analyzeFixture({ engagement_streams: ["user/42/state/com.google/starred", "user/-/label/Topic", "user/-/label/search", "user/-/state/com.google/read"] }, {
    tags: [
      { id: "user/-/state/com.google/starred" }, { id: "user/-/state/com.google/read" },
      { id: "user/-/label/not-worth-it", type: "tag" }, { id: "user/-/label/automation", type: "tag" },
      { id: "user/-/label/Topic", type: "folder" }, { id: "user/-/label/search", type: "active_search" },
    ],
    stream: (id) => { assert.equal(id, "user/42/state/com.google/starred"); return { items: [article("a")] }; },
    volume: () => ({ itemRefs: [{ id: "1" }, { id: "2" }] }),
  });
  assert.equal(urls.length, 5);
  assert.equal(result.summary.engagement_tags_used, 1);
  assert.equal(result.feeds[0].engaged_count, 1);
});

test("full final engagement page is complete even when it reaches the page cap", async () => {
  const { result } = await analyzeFixture({ engagement_pages: 1, sort_by: "engaged_count" }, {});
  assert.equal(result.summary.has_more_engaged, false);
  assert.equal(result.feeds[0].engagement_complete, true);
  assert.equal(result.feeds[0].total_articles, null);
  assert.equal(result.feeds[0].engagement_rate, null, "unknown denominator is not zero");
});

test("volume budget exhaustion preserves observed count but withholds exact posterior", async () => {
  const { result, urls } = await analyzeFixture({ max_requests: 5 }, { volume: () => ({ itemRefs: [{ id: "1" }], continuation: "more" }) });
  assert.equal(urls.length, 5);
  const row = result.feeds[0];
  assert.equal(row.total_articles, 1); assert.equal(row.volume_complete, false);
  assert.equal(row.engagement_rate, null); assert.equal(row.posterior_alpha, null); assert.equal(row.skipped, null);
  assert.match(result.summary.degraded.join(" "), /page lengths are not totals/);
});

test("inconsistent retained denominator is not silently floored", async () => {
  const { result } = await analyzeFixture({}, { stream: () => ({ items: [article("a"), article("b")] }), volume: () => ({ itemRefs: [{ id: "1" }] }) });
  const row = result.feeds[0];
  assert.equal(row.total_articles, 1); assert.equal(row.engaged_count, 2);
  assert.equal(row.retention_adjusted, true); assert.equal(row.volume_complete, true);
  assert.equal(row.posterior_beta, null); assert.equal(row.ci_low, null); assert.equal(row.skipped, null);
  assert.match(result.summary.degraded.join(" "), /not floored/);
});

test("failed/missing volume and incomplete engagement stay unknown", async () => {
  let run = await analyzeFixture({}, { volume: () => json({ error: "denied" }, 400) });
  assert.equal(run.result.feeds[0].total_articles, null); assert.equal(run.result.feeds[0].volume_complete, false);
  assert.equal(run.result.feeds[0].engagement_rate, null);
  run = await analyzeFixture({ max_requests: 3 }, {});
  const row = run.result.feeds[0];
  assert.equal(row.engaged_count, null); assert.equal(row.engagement_complete, false);
  assert.equal(row.engagement_rate, null); assert.equal(row.status, "unknown");
});

test("excluded operational folders do not participate in multi-topic prior averaging", async () => {
  const subscriptions = [subscription("feed/a", ["A", "B", "Priority"]), subscription("feed/b", ["A"]), subscription("feed/c", ["B"])];
  const items = [article("a", "feed/a"), ...Array.from({ length: 3 }, (_, i) => article(`b${i}`, "feed/b")), ...Array.from({ length: 7 }, (_, i) => article(`c${i}`, "feed/c"))];
  const { result } = await analyzeFixture({ exclude_topic_folders: ["user/-/label/Priority"] }, {
    subscriptions, stream: () => ({ items }), volume: () => ({ itemRefs: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })) }),
  });
  assert.equal(result.summary.prior.by_category.Priority, undefined);
  const row = result.feeds.find((f: { id: string }) => f.id === "feed/a");
  assert.deepEqual(row.folders, ["A", "B", "Priority"], "no folder membership is changed");
  assert.ok(Math.abs(row.posterior_alpha - 4) < 1e-9, "prior alpha averages A=2 and B=4 then adds k=1");
  assert.ok(Math.abs(row.posterior_beta - 16) < 1e-9);
});

test("default reads stay fresh and untyped labels are not silently trusted", async () => {
  const first = await analyzeFixture({ sort_by: "engaged_count" }, { stream: () => ({ items: [article("a")] }) });
  const second = await analyzeFixture({ sort_by: "engaged_count" }, { stream: () => ({ items: [article("a"), article("b")] }) });
  assert.equal(first.urls.length, 4); assert.equal(second.urls.length, 4);
  assert.equal(first.result.feeds[0].engaged_count, 1); assert.equal(second.result.feeds[0].engaged_count, 2);
  const unknown = await analyzeFixture({}, { tags: [{ id: "user/-/label/Unknown" }] });
  assert.equal(unknown.urls.length, 3);
  assert.equal(unknown.result.feeds[0].engagement_complete, false);
  assert.equal(unknown.result.feeds[0].engaged_count, null);
});

test("repeated continuations and malformed volume cannot claim exact coverage", async () => {
  const repeated = await analyzeFixture({ max_requests: 10 }, { volume: () => ({ itemRefs: [{ id: "1" }], continuation: "same" }) });
  assert.equal(repeated.urls.length, 6, "repeated cursor stops before exhausting the workflow budget");
  assert.equal(repeated.result.feeds[0].volume_complete, false);
  assert.equal(repeated.result.feeds[0].posterior_alpha, null);
  const missing = await analyzeFixture({}, { volume: () => ({}) });
  assert.equal(missing.result.feeds[0].total_articles, null);
  assert.equal(missing.result.feeds[0].volume_complete, false);
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
