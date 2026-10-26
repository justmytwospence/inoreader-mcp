import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "inoreader-api-budget-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.parse("2099-01-01") }));
process.env.INOREADER_CONFIG_DIR = dir;
const { apiGet, apiPost } = await import("../src/api.js");
const { assertBudget, getState, noteRequest, snapshot, updateFromHeaders, zoneRemaining } = await import("../src/rate-limit.js");
const { applyFolderIntents } = await import("../src/verify.js");
const { applyTagIntents } = await import("../src/verify-tags.js");
after(() => rmSync(dir, { recursive: true, force: true }));
let epoch = Date.parse("2027-01-01T00:00:00Z");
function setup(t: TestContext) {
  epoch += 7 * 86400000;
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const waits: number[] = [];
  t.mock.method(globalThis, "setTimeout", (fn: () => void, delay = 0) => {
    waits.push(delay); t.mock.timers.tick(delay); queueMicrotask(fn); return 0;
  });
  t.mock.method(Math, "random", () => 0.5);
  updateFromHeaders(new Headers({
    "x-reader-zone1-limit": "2000", "x-reader-zone1-usage": "0",
    "x-reader-zone2-limit": "2000", "x-reader-zone2-usage": "0", "x-reader-limits-reset-after": "3600",
  }));
  return waits;
}
function json(data: unknown = {}, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

test("every safe-read attempt counts and every retry response updates headers", async (t) => {
  const waits = setup(t);
  const before = getState().local.zone1Count;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return json({}, { "x-reader-zone1-usage": "1", "x-reader-zone2-usage": "7" }, 503);
    assert.equal(getState().zone1.usage, 1, "first error response must already be ingested");
    assert.equal(getState().zone2.usage, 7);
    return json({ ok: true }, { "x-reader-zone1-usage": "2" });
  });
  assert.deepEqual(await apiGet("/reader/api/0/test"), { ok: true });
  assert.equal(calls, 2);
  assert.equal(getState().local.zone1Count - before, 2);
  assert.equal(getState().zone1.usage, 2);
  assert.deepEqual(waits, [250]);
});

test("429 Retry-After is honored once, accounting includes the rejected response", async (t) => {
  const waits = setup(t);
  const before = getState().zone1.attemptCount!;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? json({}, { "retry-after": "2", "x-reader-zone1-usage": "1" }, 429)
    : json({ ok: true }, { "x-reader-zone1-usage": "2" }));
  await apiGet("/reader/api/0/test");
  assert.deepEqual(waits, [2000]);
  assert.equal(getState().zone1.attemptCount! - before, 2);
  assert.equal(snapshot().zone1_reads.cooldown_until, null);
});

test("long HTTP-date Retry-After persists cooldown and blocks new attempts without sleeping", async (t) => {
  const waits = setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return json({}, { "retry-after": new Date(Date.now() + 120000).toUTCString(), "x-reader-zone1-usage": "77" }, 429);
  });
  await assert.rejects(apiGet("/reader/api/0/test"), /cooldown persisted/);
  assert.equal(getState().zone1.usage, 77);
  await assert.rejects(apiGet("/reader/api/0/test"), /cooldown/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(snapshot().zone1_reads.cooldown_until, new Date(Date.now() + 120000).toISOString());
});

test("transport failures and final errors count; Zone 1 POST reads retry too", async (t) => {
  setup(t);
  const before = getState().zone1.attemptCount!;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("lost connection");
    return json({}, { "x-reader-zone1-usage": String(calls) }, 503);
  });
  await assert.rejects(apiPost("/reader/api/0/stream/items/contents", { i: "123" }), /503/);
  assert.equal(calls, 4);
  assert.equal(getState().zone1.attemptCount! - before, 4);
  assert.equal(getState().zone1.usage, 4);
});

test("ambiguous writes, 5xx and unexpected JSON OK bodies are never replayed", async (t) => {
  setup(t);
  const before = getState().zone2.attemptCount!;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("lost after sending");
    if (calls === 2) return json({}, { "x-reader-zone2-usage": "2" }, 503);
    return json({ accepted: true });
  });
  await assert.rejects(apiPost("/reader/api/0/rename-tag", {}), /Outcome unknown.*Not replayed/);
  assert.equal(calls, 1);
  await assert.rejects(apiPost("/reader/api/0/subscription/edit", {}), /Not replayed/);
  assert.equal(calls, 2);
  await assert.rejects(apiPost("/reader/api/0/edit-tag", {}, undefined, { expectOk: true }), /unexpected body/);
  assert.equal(calls, 3);
  assert.equal(getState().zone2.attemptCount! - before, 3);
});

test("redirects cannot hide extra HTTP attempts or replay writes", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response("redirect", { status: 307, headers: { location: "https://www.inoreader.com/elsewhere", "x-reader-zone2-usage": "1" } });
  });
  await assert.rejects(apiPost("/reader/api/0/subscription/edit", {}), /307/);
  assert.equal(calls, 1);
  assert.equal(getState().zone2.usage, 1);
});

test("zone timestamps only refresh observed fields; reset-only headers cannot revive expired usage", (t) => {
  setup(t);
  const old = getState().zone2;
  t.mock.timers.tick(1000);
  updateFromHeaders(new Headers({ "x-reader-zone1-usage": "9" }));
  assert.equal(getState().zone2.lastUpdated, old.lastUpdated);
  assert.equal(getState().zone2.usageObservedAt, old.usageObservedAt);
  const usageTime = getState().zone1.usageObservedAt;
  t.mock.timers.tick(1000);
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "3000" }));
  assert.equal(getState().zone1.usageObservedAt, usageTime);
  assert.ok(getState().zone1.limitObservedAt! > usageTime!);
  noteRequest(1);
  assert.equal(zoneRemaining(1).source, "headers+local-estimate");
  assert.equal(zoneRemaining(1).remaining, 2990);
  t.mock.timers.tick(3600000);
  updateFromHeaders(new Headers({ "x-reader-limits-reset-after": "3600" }));
  assert.equal(zoneRemaining(1).remaining, null);
  assert.equal(snapshot().zone1_reads.observation_expired, true);
});

test("out-of-order responses cannot lower usage and pending attempts consume estimated headroom", (t) => {
  setup(t);
  const first = noteRequest(1);
  const second = noteRequest(1);
  updateFromHeaders(new Headers({ "x-reader-zone1-usage": "2" }), second);
  updateFromHeaders(new Headers({ "x-reader-zone1-usage": "1" }), first);
  assert.equal(getState().zone1.usage, 1, "raw latest header is not replaced with an estimate");
  assert.equal(getState().zone1.conservativeUsage, 2);
  assert.equal(zoneRemaining(1).remaining, 1997, "conservative extra pending call is not free");
});

test("concurrent admission does not overspend the last known request", async (t) => {
  setup(t);
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "1", "x-reader-zone1-usage": "0" }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({}); });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => apiGet("/reader/api/0/test")));
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(zoneRemaining(1).remaining, 0);
  assert.throws(() => assertBudget(1, 1, "test workflow"), /Insufficient/);
});

test("aggregate concurrency is 4 across callers and holds slots until bodies finish", async (t) => {
  setup(t);
  let active = 0, peak = 0, calls = 0;
  const release: Array<() => void> = [];
  t.mock.method(globalThis, "fetch", async () => {
    calls++; active++; peak = Math.max(peak, active);
    return new Response(new ReadableStream({ start(controller) {
      release.push(() => { active--; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); });
    } }), { headers: { "content-type": "application/json" } });
  });
  const work = Promise.all(Array.from({ length: 12 }, () => apiGet("/reader/api/0/test")));
  for (let batch = 0; batch < 3; batch++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(release.length, 4);
    release.splice(0).forEach((done) => done());
  }
  await work;
  assert.equal(calls, 12); assert.equal(peak, 4); assert.equal(active, 0);
});

test("UTC daily display rolls over during a long-lived process, without inventing quota reset", (t) => {
  setup(t);
  noteRequest(1);
  const observed = getState().zone1.usageObservedAt;
  t.mock.timers.tick(86400000);
  assert.equal(snapshot().counted_locally_today.zone1, 0);
  assert.equal(getState().zone1.usageObservedAt, observed);
  assert.equal(zoneRemaining(1).remaining, null);
});

test("verified folder writes survive lost responses without replay; absent state stays unverified", async (t) => {
  setup(t);
  let writes = 0, reads = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new TypeError("reply lost"); }
    reads++;
    return json({ subscriptions: [{ id: "feed/x", categories: [{ label: "New" }] }] });
  });
  const report = await applyFolderIntents([{ streamId: "feed/x", folder: "New" }]);
  assert.equal(report.verified, 1); assert.equal(writes, 1); assert.equal(reads, 1);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; return new Response("OK"); }
    return json({ subscriptions: [] });
  });
  const missing = await applyFolderIntents([{ streamId: "feed/absent", folder: "New" }]);
  assert.equal(missing.verified, 0); assert.equal(missing.unverified, 1);
  assert.equal(writes, 2, "unknown/absent subscription must not trigger another write");
});

test("safe-read retries cannot consume an expensive workflow's reserved headroom", async (t) => {
  setup(t);
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "26", "x-reader-zone1-usage": "0" }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({}, {}, 503); });
  await assert.rejects(apiGet("/reader/api/0/test", {}, { reserve: 25 }), /25 reserve/);
  assert.equal(calls, 1);
  assert.equal(zoneRemaining(1).remaining, 25);
});

test("verified folder moves retain split reconciliation for observed combined-edit shortfalls", async (t) => {
  setup(t);
  const writes: URLSearchParams[] = [];
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(new URLSearchParams(init.body as URLSearchParams)); return new Response("OK"); }
    reads++;
    return json({ subscriptions: [{ id: "feed/x", categories: writes.length < 3 ? [{ label: "New" }, { label: "Old" }] : [{ label: "New" }] }] });
  });
  const report = await applyFolderIntents([{ streamId: "feed/x", folder: "New" }], { removeFrom: "Old" });
  assert.equal(report.verified, 1); assert.equal(report.rounds, 2); assert.equal(writes.length, 3); assert.equal(reads, 3);
  assert.ok(writes[0].has("a") && writes[0].has("r"));
  assert.ok(writes[1].has("a") && !writes[1].has("r"));
  assert.ok(!writes[2].has("a") && writes[2].has("r"));
});

test("tag writes reconcile observed shortfalls only; absent articles and failed reads are not replayed", async (t) => {
  setup(t);
  let writes = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("edit-tag")) { writes++; return new Response("OK"); }
    return json({ items: [] });
  });
  const absent = await applyTagIntents([{ articleId: "123", addTag: "Keep" }], (tag) => `user/-/label/${tag}`);
  assert.equal(absent.verified, 0); assert.equal(writes, 1);
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("edit-tag")) { writes++; return new Response("OK"); }
    return json({}, {}, 400);
  });
  const failedRead = await applyTagIntents([{ articleId: "456", addTag: "Keep" }], (tag) => `user/-/label/${tag}`);
  assert.equal(failedRead.verification, "none"); assert.equal(failedRead.verified, 0);
  assert.equal(writes, 2);
});
