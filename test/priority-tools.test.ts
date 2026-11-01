import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PriorityProfile } from "../src/priority/config.js";
import type { PrioritySnapshot } from "../src/priority/store.js";
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
function provisionalProfile(name: string): PriorityProfile {
  const base = { ...p, name, promotion_mode: "provisional" as const, promotion_probability: 0.95, auto_add_enabled: true };
  return parsePriorityConfig({ profiles: [{ ...base, provisional_review: { acknowledged_uncalibrated: true, config_hash: configHash(base), promotion_probability: 0.95, reviewed_at: new Date().toISOString() } }] })[0];
}
function completeHistory(profile: PriorityProfile, id = "history"): PrioritySnapshot {
  const at = Date.now(), articles = Array.from({ length: 50 }, (_, i) => ({ id: `a-${i}`, timestamp: at - 8 * 86400000 }));
  const baseline = Array.from({ length: 1000 }, (_, i) => ({ id: `b-${i}`, timestamp: at - 8 * 86400000 }));
  return { version: 1, id, config_hash: configHash(profile), model: "category-beta-v1", started_at: at, completed_at: at + 1, cutoff: at - 365 * 86400000, phase: "complete", source_index: 1, feed_index: 2, continuation: null, base_reads: 6,
    subscriptions: [sub(), { ...sub(), id: "feed/b", title: "Baseline" }], signal_sources: profile.positive_streams, source_coverage: Object.fromEntries(profile.positive_streams.map(id => [id, true])),
    signals: { "feed/a": articles.slice(0, 40).map(a => ({ ...a, timestamp: at })), "feed/b": baseline.slice(0, 1) }, feed_ids: ["feed/a", "feed/b"],
    volumes: { "feed/a": { articles, complete: true, observed_at: at }, "feed/b": { articles: baseline, complete: true, observed_at: at } }, prospective: {}, membership: [], errors: [] };
}
async function storeHistory(profile: PriorityProfile, snapshot: PrioritySnapshot) {
  const d = await readDecisions(profile.name); d.latest_snapshot = snapshot.id;
  await saveDecisions(profile.name, d); await saveSnapshot(profile.name, snapshot);
}
test("reviewed provisional status selects history honestly and one complete snapshot can add", async () => {
  const profile = provisionalProfile("provisional-success"), s = completeHistory(profile);
  await storeHistory(profile, s);
  resetQuota(); let member = false, posts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; const body = new URLSearchParams(String(init.body)); assert.equal(body.get("a"), "user/-/label/Priority"); member = true; return new Response("OK"); }
    return json({ subscriptions: [sub(member), { ...sub(), id: "feed/b" }] });
  }) as typeof fetch;
  const status = await getPriorityStatus(profile, {});
  assert.equal(posts, 0);
  assert.equal(status.calibration.ready_for_review, false);
  assert.deepEqual(status.activation, { mode: "provisional", evidence_basis: "mature_historical", ready_for_additions: true, calibrated: false });
  assert.equal(status.feeds[0].promotion_evidence.n, 50);
  assert.equal(status.summary.rate_quantiles_basis, "mature_historical");
  assert.ok(Object.values(status.summary.rate_quantiles).every(value => value !== null));
  assert.equal(status.summary.rate_quantiles["0.5"], Math.min(...status.feeds.map(row => row.promotion_evidence.posterior!.mean)));
  assert.equal(status.summary.promotion_priors?.global_observations, 1050);
  assert.ok(status.summary.cutoff_sweep.every(row => row.basis === "mature_historical"));
  const result = await managePriority(profile, { action: "auto_add", stream_id: "feed/a", snapshot_id: s.id, reason: "Daily selected candidate" });
  assert.equal(result.status, "verified"); assert.equal(posts, 1);
  const d = await readDecisions(profile.name);
  assert.match(d.intents[0].reason, /Provisional uncalibrated mature-historical/);
  assert.equal(d.intents[0].snapshot_id, s.id);
});
test("backend checks actual provisional review, complete fresh source coverage, exclusions and caps", async () => {
  let posts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { if (init?.method === "POST") posts++; return json({ subscriptions: [sub()] }); }) as typeof fetch;
  for (const change of [
    (x: PriorityProfile) => { x.provisional_review = undefined; },
    (x: PriorityProfile) => { x.provisional_review!.config_hash = "0".repeat(64); },
    (x: PriorityProfile) => { x.promotion_probability = 0.94; x.provisional_review!.promotion_probability = 0.94; },
    (x: PriorityProfile) => { x.provisional_review!.promotion_probability = 0.96; },
  ]) {
    const profile = provisionalProfile("bad-review"); change(profile); resetQuota();
    assert.equal((await getPriorityStatus(profile, {})).activation.ready_for_additions, false);
    await assert.rejects(managePriority(profile, { action: "auto_add", stream_id: "feed/a", reason: "Untrusted caller claims eligibility" }), /not reviewed/);
  }
  for (const [name, change] of [
    ["partial", (s: PrioritySnapshot) => { s.phase = "volumes"; s.completed_at = null; }],
    ["old", (s: PrioritySnapshot) => { s.started_at -= 8 * 86400000; }],
    ["missing-source", (s: PrioritySnapshot) => { s.source_coverage = {}; }],
  ] as const) {
    const profile = provisionalProfile(name), s = completeHistory(profile); change(s); await storeHistory(profile, s); resetQuota();
    assert.equal((await getPriorityStatus(profile, {})).activation.ready_for_additions, false);
    await assert.rejects(managePriority(profile, { action: "auto_add", stream_id: "feed/a", reason: "Daily" }), /fresh complete/);
  }
  for (const name of ["unknown-exposure", "excluded", "weekly-cap", "snapshot-cap"]) {
    const profile = provisionalProfile(name), s = completeHistory(profile);
    if (name === "unknown-exposure") s.signals["feed/a"].push({ id: "unknown", timestamp: s.cutoff - 86400000 });
    await storeHistory(profile, s);
    const d = await readDecisions(profile.name);
    if (name === "excluded") d.preferences["feed/a"] = { pin: false, exclude: true, history: [] };
    if (name.endsWith("cap")) d.intents = Array.from({ length: 5 }, (_, i) => ({ id: `spent-${i}`, reason: "Reserved", config_hash: configHash(profile), original_topic_ids: [], stream_id: `feed/spent-${i}`, action: "auto_add", at: Date.now(), week: name === "weekly-cap" ? new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) : "earlier-week", ...(name === "snapshot-cap" ? { snapshot_id: s.id } : {}), status: "unverified" }));
    await saveDecisions(profile.name, d); resetQuota();
    await assert.rejects(managePriority(profile, { action: "auto_add", stream_id: "feed/a", reason: "Daily" }), /not eligible/);
  }
  assert.equal(posts, 0);
});
test("calibrated mode still requires held-out readiness despite a matching explicit review", async () => {
  const base = { ...p, name: "calibrated-heldout", auto_add_enabled: true, promotion_probability: 0.8 };
  const profile = { ...base, calibration: { reviewed: true as const, config_hash: configHash(base), promotion_probability: 0.8, reviewed_at: new Date().toISOString() } };
  const s = completeHistory(profile); await storeHistory(profile, s); resetQuota();
  let posts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { if (init?.method === "POST") posts++; return json({ subscriptions: [sub()] }); }) as typeof fetch;
  const status = await getPriorityStatus(profile, {});
  assert.equal(status.activation.mode, "calibrated"); assert.equal(status.activation.evidence_basis, "prospective"); assert.equal(status.activation.ready_for_additions, false);
  await assert.rejects(managePriority(profile, { action: "auto_add", stream_id: "feed/a", reason: "Daily" }), /Insufficient held-out calibration/);
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
