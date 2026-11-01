import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
const dir = mkdtempSync(join(tmpdir(), "inoreader-priority-tools-"));
const priorEnv = { config: process.env.INOREADER_CONFIG_DIR, priority: process.env.INOREADER_PRIORITY_CONFIG, transport: process.env.MCP_TRANSPORT };
process.env.INOREADER_CONFIG_DIR = dir; process.env.MCP_TRANSPORT = "http";
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 }));
const { parsePriorityConfig, configHash } = await import("../src/priority/config.js");
const { getPriorityStatus, managePriority, migratePriorityFeed, registerPriorityTools } = await import("../src/priority/tools.js");
const { readDecisions, saveDecisions, saveSnapshot, withProfileLock } = await import("../src/priority/store.js");
const { updateFromHeaders } = await import("../src/rate-limit.js");
const raw = { profiles: [{ name: "test", folder: "Priority", positive_streams: ["user/-/state/com.google/starred"] }] };
const p = parsePriorityConfig(raw)[0];
const configPath = join(dir, "config.json"); writeFileSync(configPath, JSON.stringify(raw));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["INOREADER_CONFIG_DIR", priorEnv.config], ["INOREADER_PRIORITY_CONFIG", priorEnv.priority], ["MCP_TRANSPORT", priorEnv.transport]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
});
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
function resetQuota() { updateFromHeaders(new Headers({ "x-reader-zone1-limit": "10000", "x-reader-zone1-usage": "1", "x-reader-zone2-limit": "10000", "x-reader-zone2-usage": "1", "x-reader-limits-reset-after": "3600" })); }
const sub = (member = false) => ({ id: "feed/a", title: "A", url: "https://example.test/a", htmlUrl: "", categories: [{ id: "user/-/label/Topic", label: "Topic" }, ...(member ? [{ id: "user/-/label/Priority", label: "Priority" }] : [])] });
test("feature-off inventory unchanged; feature-on exactly three tools; HTTP required", () => {
  const names: string[] = [];
  const fake = { registerTool: (name: string) => names.push(name) } as unknown as McpServer;
  delete process.env.INOREADER_PRIORITY_CONFIG; registerPriorityTools(fake); assert.deepEqual(names, []);
  process.env.INOREADER_PRIORITY_CONFIG = configPath; registerPriorityTools(fake);
  assert.deepEqual(names, ["refresh_feed_priority", "get_feed_priority", "manage_feed_priority"]);
  process.env.MCP_TRANSPORT = "stdio"; assert.throws(() => registerPriorityTools(fake), /MCP_TRANSPORT=http/); process.env.MCP_TRANSPORT = "http";
});
test("status and exclude/allow are zero-call; disabled auto-add cannot edit", async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; return json({ subscriptions: [sub()] }); }) as typeof fetch;
  const status = await getPriorityStatus(p, {}); assert.equal(calls, 0); assert.equal(status.collection, null); assert.equal(status.calibration.ready_for_review, false);
  await managePriority(p, { stream_id: "feed/a", action: "exclude", reason: "User veto" });
  await managePriority(p, { stream_id: "feed/a", action: "allow", reason: "User clears preference" }); assert.equal(calls, 0);
  await assert.rejects(managePriority(p, { stream_id: "feed/a", action: "auto_add", reason: "Scheduled" }), /disabled/); assert.equal(calls, 1);
});
test("late completion cannot disguise stale collection for automatic additions", async () => {
  const stale = { ...p, name: "stale", promotion_probability: 0.8, auto_add_enabled: true };
  const enabled = { ...stale, calibration: { reviewed: true as const, config_hash: configHash(stale), promotion_probability: 0.8, reviewed_at: new Date().toISOString() } };
  const at = Date.now() - 8 * 86400000;
  const d = await readDecisions(enabled.name); d.latest_snapshot = "stale-snapshot"; await saveDecisions(enabled.name, d);
  await saveSnapshot(enabled.name, { version: 1, id: "stale-snapshot", config_hash: configHash(enabled), model: "category-beta-v1", started_at: at, completed_at: Date.now(), cutoff: at - 365 * 86400000, phase: "complete", source_index: 1, feed_index: 0, continuation: null, base_reads: 4, subscriptions: [sub()], signal_sources: enabled.positive_streams, source_coverage: { [enabled.positive_streams[0]]: true }, signals: {}, feed_ids: [], volumes: {}, prospective: {}, membership: [], errors: [] });
  resetQuota(); let posts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { if (init?.method === "POST") posts++; return json({ subscriptions: [sub()] }); }) as typeof fetch;
  assert.equal((await getPriorityStatus(enabled, {})).collection?.stale, true);
  await assert.rejects(managePriority(enabled, { stream_id: "feed/a", action: "auto_add", reason: "Scheduled" }), /fresh complete/);
  assert.equal(posts, 0);
});
test("pin/remove verify only priority folder changes and remove exclusion persists", async () => {
  resetQuota(); let member = false; const bodies: URLSearchParams[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { const body = new URLSearchParams(String(init.body)); bodies.push(body); if (body.has("a")) member = true; if (body.has("r")) member = false; return new Response("OK"); }
    assert.ok(String(input).includes("subscription/list")); return json({ subscriptions: [sub(member)] });
  }) as typeof fetch;
  const pin = await withProfileLock(p.name, () => managePriority(p, { stream_id: "feed/a", action: "pin", reason: "Explicit user request" }));
  assert.equal(pin.status, "verified"); assert.equal(member, true);
  const remove = await withProfileLock(p.name, () => managePriority(p, { stream_id: "feed/a", action: "remove", reason: "Explicit user removal request" }));
  assert.equal(remove.status, "verified"); assert.equal(member, false);
  assert.deepEqual([...bodies[0].keys()].sort(), ["a", "ac", "s"]); assert.deepEqual([...bodies[1].keys()].sort(), ["ac", "r", "s"]);
  assert.equal(bodies[1].get("r"), "user/-/label/Priority"); assert.ok(bodies.every(b => b.get("ac") === "edit"));
  assert.equal((await readDecisions(p.name)).preferences["feed/a"].exclude, true);
});
test("uncertain write persisted and later reconciled without blind replay", async () => {
  resetQuota(); await managePriority(p, { stream_id: "feed/a", action: "allow", reason: "Explicit clear" });
  let posts = 0, failVerification = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; failVerification = true; return new Response("not acknowledged", { status: 200 }); }
    return failVerification ? json({}, 400) : json({ subscriptions: [sub()] });
  }) as typeof fetch;
  const first = await managePriority(p, { stream_id: "feed/a", action: "pin", reason: "Explicit request" }); assert.equal(first.status, "unverified");
  failVerification = false;
  const retry = await managePriority(p, { stream_id: "feed/a", action: "pin", reason: "Repeat request" });
  assert.equal(retry.status, "not_applied"); assert.equal(retry.reconciliation_only, true); assert.equal(posts, 1);
  let member = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; member = true; return new Response("OK"); }
    return json({ subscriptions: [sub(member)] });
  }) as typeof fetch;
  const explicitRetry = await managePriority(p, { stream_id: "feed/a", action: "pin", reason: "New explicit request after verified no-op" });
  assert.equal(explicitRetry.status, "verified"); assert.equal(posts, 2);
});
test("acknowledged no-op is terminal not_applied and only a later explicit request retries", async () => {
  const noopProfile = { ...p, name: "noop" };
  resetQuota(); let posts = 0, member = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; if (posts > 1) member = true; return new Response("OK"); }
    return json({ subscriptions: [sub(member)] });
  }) as typeof fetch;
  const first = await managePriority(noopProfile, { stream_id: "feed/a", action: "pin", reason: "Explicit initial request" });
  assert.equal(first.status, "not_applied"); assert.equal(posts, 1);
  assert.equal((await readDecisions(noopProfile.name)).intents[0].status, "not_applied");
  const second = await managePriority(noopProfile, { stream_id: "feed/a", action: "pin", reason: "Later explicit retry" });
  assert.equal(second.status, "verified"); assert.equal(posts, 2);
});
test("replacement migration preserves veto history over conflicting pin, and disabled migration is a safe no-op", async () => {
  process.env.INOREADER_PRIORITY_CONFIG = configPath;
  const d = await readDecisions(p.name);
  d.preferences["feed/old"] = { pin: false, exclude: true, history: [{ action: "exclude", reason: "User veto", at: Date.now(), config_hash: "test" }] };
  d.preferences["feed/new"] = { pin: true, exclude: false, history: [] }; await saveDecisions(p.name, d);
  await migratePriorityFeed("feed/old", "feed/new");
  const migrated = await readDecisions(p.name);
  assert.equal(migrated.preferences["feed/new"].exclude, true); assert.equal(migrated.preferences["feed/new"].pin, false);
  assert.ok(migrated.preferences["feed/new"].history.some(h => h.reason === "User veto")); assert.equal(migrated.migrations[0].status, "complete");
  delete process.env.INOREADER_PRIORITY_CONFIG; await migratePriorityFeed("feed/absent", "feed/other");
  assert.equal((await readDecisions(p.name)).preferences["feed/other"], undefined);
});
