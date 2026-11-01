import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const dir = mkdtempSync(join(tmpdir(), "priority-evidence-"));
const previousDir = process.env.INOREADER_CONFIG_DIR;
process.env.INOREADER_CONFIG_DIR = dir;
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 365 * 86400000 }));
const { parsePriorityConfig } = await import("../src/priority/config.js");
const { refreshEvidence, DAY } = await import("../src/priority/evidence.js");
const { readSnapshot, readDecisions } = await import("../src/priority/store.js");
const { evaluateSnapshot } = await import("../src/priority/policy.js");
const { updateFromHeaders } = await import("../src/rate-limit.js");
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
after(() => {
  globalThis.fetch = originalFetch; Date.now = originalNow;
  if (previousDir === undefined) delete process.env.INOREADER_CONFIG_DIR; else process.env.INOREADER_CONFIG_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const tag = "user/-/label/Saved";
const feed = "feed/one";
const profile = (name: string, streams = [tag]) => parsePriorityConfig({ profiles: [{ name, folder: "Priority", positive_streams: streams }] })[0];
const sub = (member = false) => ({ id: feed, title: "One", categories: [{ id: `user/-/label/${member ? "Priority" : "News"}`, label: member ? "Priority" : "News" }], url: "https://example.com/feed", htmlUrl: "https://example.com/" });
const article = (id: string, ms: number) => ({ id, published: Math.floor((ms - DAY) / 1000), timestampUsec: String(ms * 1000), origin: { streamId: feed }, categories: [] });
const refs = (items: ReturnType<typeof article>[]) => items.map(({ id, timestampUsec }) => ({ id, timestampUsec }));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function mock(handler: (url: URL) => unknown, metadata: unknown = { unreadcounts: [] }) {
  const urls: URL[] = [];
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "10000", "x-reader-zone1-usage": "0", "x-reader-limits-reset-after": "3600" }));
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET", "evidence collection must never write upstream");
    const url = new URL(String(input)); urls.push(url);
    const volume = url.pathname === "/reader/api/0/stream/items/ids";
    if (volume) {
      assert.equal(url.searchParams.get("output"), "json");
      assert.equal(url.searchParams.get("n"), "10000");
      assert.equal(url.searchParams.get("s"), feed);
    } else if (url.pathname.includes("/stream/contents/")) {
      assert.equal(url.searchParams.get("output"), "json");
      assert.equal(url.searchParams.get("n"), "1000");
    }
    if (url.pathname === "/reader/api/0/unread-count") {
      assert.equal(url.searchParams.get("output"), "json");
      return json(metadata);
    }
    const result = handler(url);
    return result instanceof Response ? result : json(result);
  }) as typeof fetch;
  return urls;
}
const streamId = (url: URL) => decodeURIComponent(url.pathname.split("/stream/contents/")[1] ?? "");

test("native numeric and legacy string subscription timestamps checkpoint and resume", async () => {
  for (const firstitemmsec of [1790000000000, "1790000000000"]) {
    const p = profile(`native-metadata-${typeof firstitemmsec}`);
    const urls = mock(url => {
      if (url.pathname.endsWith("subscription/list")) return { subscriptions: [{ ...sub(), firstitemmsec }] };
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const first = await refreshEvidence(p, { start_new: true, max_requests: 1 });
    assert.equal(first.progress.phase, "metadata");
    assert.deepEqual(first.progress.errors, []);
    assert.equal(first.used_reads, 1);
    assert.equal((await readSnapshot(p.name, first.snapshot_id)).subscriptions[0].firstitemmsec, firstitemmsec);
    const next = await refreshEvidence(p, { snapshot_id: first.snapshot_id, max_requests: 1 });
    assert.equal(next.progress.phase, "tags");
    assert.equal(urls.filter(url => url.pathname.endsWith("subscription/list")).length, 1);
  }
});

test("invalid subscription metadata records its read cost without corrupting the cursor", async () => {
  const p = profile("invalid-native-metadata");
  mock(() => ({ subscriptions: [{ ...sub(), firstitemmsec: { invalid: true } }] }));
  const r = await refreshEvidence(p, { start_new: true, max_requests: 1 });
  assert.equal(r.complete, false);
  assert.equal(r.used_reads, 1);
  assert.equal(r.total_base_reads, 1);
  assert.equal(r.progress.phase, "subscriptions");
  assert.match(r.progress.errors.join(" "), /firstitemmsec/);
  const snapshot = await readSnapshot(p.name, r.snapshot_id);
  assert.equal(snapshot.subscriptions.length, 0);
  assert.equal(snapshot.base_reads, 1);
});

test("one-read checkpoints resume after a process restart and finish paged volumes", async () => {
  const p = profile("resume");
  const now = Date.now();
  const urls = mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) { assert.equal(url.searchParams.get("types"), "1"); return { tags: [{ id: tag, type: "tag" }] }; }
    if (streamId(url) === tag) return { items: [article("Positive", now - DAY)], continuation: "signal-next" };
    assert.equal(url.pathname, "/reader/api/0/stream/items/ids");
    return url.searchParams.get("c") ? { itemRefs: refs([article("Second", now - DAY)]) } : { itemRefs: refs([article("Positive", now - DAY)]), continuation: "volume-next" };
  });
  let r = await refreshEvidence(p, { start_new: true, max_requests: 1 });
  const id = r.snapshot_id;
  assert.equal(r.used_reads, 1); assert.equal(r.next_cursor?.phase, "metadata");
  assert.equal((await readDecisions(p.name)).active_snapshot, id);
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.equal(r.used_reads, 1); assert.equal(r.next_cursor?.phase, "tags");
  assert.deepEqual((await readSnapshot(p.name, id)).newest_item_timestamps, {});
  r = await refreshEvidence(p, { max_requests: 1 });
  assert.equal(r.used_reads, 1); assert.equal(r.next_cursor?.phase, "signals");
  r = await refreshEvidence(p, { max_requests: 1 });
  assert.equal(r.used_reads, 1); assert.equal(r.next_cursor?.continuation, "signal-next");
  let s = await readSnapshot(p.name, id);
  assert.equal(s.source_coverage[tag], false); assert.equal(s.signals[feed].length, 1);
  const moduleUrl = new URL("../src/priority/evidence.js", import.meta.url).href;
  const configUrl = new URL("../src/priority/config.js", import.meta.url).href;
  const script = `
    import { refreshEvidence } from ${JSON.stringify(moduleUrl)};
    import { parsePriorityConfig } from ${JSON.stringify(configUrl)};
    globalThis.fetch = async (input, init) => {
      const u = new URL(String(input));
      if ((init?.method ?? 'GET') !== 'GET' || !u.pathname.includes('/stream/contents/') || u.searchParams.get('output') !== 'json' || u.searchParams.get('n') !== '1000' || u.searchParams.get('c') !== 'signal-next') throw new Error('wrong resumed request');
      return new Response(JSON.stringify({items: []}), {headers: {'content-type':'application/json'}});
    };
    const p = parsePriorityConfig({profiles:[{name:'resume',folder:'Priority',positive_streams:[${JSON.stringify(tag)}]}]})[0];
    process.stdout.write(JSON.stringify(await refreshEvidence(p, {max_requests:1})));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env } });
  const resumed = JSON.parse(stdout);
  assert.equal(resumed.used_reads, 1); assert.equal(resumed.snapshot_id, id); assert.equal(resumed.next_cursor.phase, "volumes");
  s = await readSnapshot(p.name, id);
  assert.equal(s.source_coverage[tag], true); assert.equal(s.base_reads, 5);
  r = await refreshEvidence(p, { max_requests: 1 });
  assert.equal(r.complete, false); assert.equal(r.next_cursor?.continuation, "volume-next");
  s = await readSnapshot(p.name, id);
  assert.equal(s.volumes[feed].complete, false); assert.equal(s.volumes[feed].articles.length, 1);
  assert.equal((await readDecisions(p.name)).observations[feed].last_complete, null);
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.equal(r.complete, true); assert.equal(r.used_reads, 1); assert.equal(r.total_base_reads, 7); assert.equal(r.next_cursor, null);
  assert.equal(urls.at(-1)?.searchParams.get("c"), "volume-next");
  s = await readSnapshot(p.name, id);
  assert.equal(s.volumes[feed].complete, true); assert.deepEqual(s.volumes[feed].articles.map(a => a.id), ["positive", "second"]);
  assert.equal((await readDecisions(p.name)).latest_snapshot, id); assert.equal((await readDecisions(p.name)).active_snapshot, null);
});

test("default 25 and maximum 50 base reads bound resumable collection calls", async () => {
  const p = profile("bounded"); let page = 0;
  const urls = mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    page++; return { items: [article(`article-${page}`, Date.now() - DAY)], continuation: `page-${page}` };
  });
  let r = await refreshEvidence(p, { start_new: true });
  assert.equal(r.used_reads, 25); assert.equal(urls.length, 25); assert.equal(r.complete, false);
  r = await refreshEvidence(p, { snapshot_id: r.snapshot_id, max_requests: 50 });
  assert.equal(r.used_reads, 50); assert.equal(urls.length, 75); assert.equal(r.complete, false);
  await assert.rejects(refreshEvidence(p, { max_requests: 51 }), /1-50/);
  assert.equal(urls.length, 75);
});

test("only explicit verified article tags or supported state streams are collected", async () => {
  for (const [name, source, tags] of [
    ["folder", "user/-/label/News", [{ id: "user/-/label/News", type: "folder" }]],
    ["unknown", "user/-/label/Unknown", [{ id: "user/-/label/Unknown" }]],
    ["missing", "user/-/label/Missing", []],
    ["search", "user/-/label/Search", [{ id: "user/-/label/Search", type: "active_search" }]],
  ] as const) {
    const urls = mock(url => url.pathname.endsWith("subscription/list") ? { subscriptions: [sub()] } : { tags });
    const p = profile(name, [source]);
    const r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    assert.equal(r.complete, false); assert.equal(r.progress.phase, "tags");
    assert.match(r.progress.errors.join(), /not a verified article tag/);
    assert.equal(urls.length, 3); assert.equal((await readSnapshot(name, r.snapshot_id)).completed_at, null);
  }
  const p = profile("allowlist", ["user/42/label/Saved", "user/42/state/com.google/starred"]);
  const urls = mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }, { id: "user/-/label/Other", type: "tag" }] };
    return url.pathname.endsWith("/stream/items/ids") ? { itemRefs: [] } : { items: [] };
  });
  const r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
  assert.equal(r.complete, true);
  assert.deepEqual(urls.filter(u => u.pathname.includes("/stream/contents/")).map(streamId), p.positive_streams);
});

test("incomplete positive source fails closed and can resume the same page", async () => {
  const p = profile("failure"); let broken = true;
  mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    if (broken) return json({ error: "denied" }, 400);
    return url.pathname.endsWith("/stream/items/ids") ? { itemRefs: [] } : { items: [] };
  });
  let r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
  assert.equal(r.complete, false); assert.equal(r.progress.phase, "signals"); assert.match(r.progress.errors.join(), /400/);
  let s = await readSnapshot(p.name, r.snapshot_id);
  assert.equal(s.source_coverage[tag], false); assert.equal(s.completed_at, null); assert.equal((await readDecisions(p.name)).latest_snapshot, null);
  broken = false; r = await refreshEvidence(p, { max_requests: 1 });
  assert.equal(r.complete, true); s = await readSnapshot(p.name, r.snapshot_id); assert.equal(s.source_coverage[tag], true);
});

test("missing timestampUsec leaves signal and volume sources incomplete despite published", async () => {
  for (const phase of ["signals", "volumes"] as const) {
    const p = profile(`missing-time-${phase}`);
    const now = Date.now();
    const { timestampUsec: _missing, ...withoutTimestamp } = article("missing", now - DAY);
    mock(url => {
      if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
      if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
      if (streamId(url) === tag) return { items: [phase === "signals" ? withoutTimestamp : article("missing", now - DAY)] };
      return { itemRefs: [{ id: "missing", published: withoutTimestamp.published }] };
    });
    const r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    assert.equal(r.complete, false); assert.equal(r.progress.phase, phase);
    const s = await readSnapshot(p.name, r.snapshot_id);
    assert.equal(s.completed_at, null);
    if (phase === "signals") assert.equal(s.source_coverage[tag], false);
    else assert.notEqual(s.volumes[feed]?.complete, true);
  }
});

test("decimal volume IDs and hexadecimal signal IDs match and deduplicate", async () => {
  const p = profile("normalized-ids");
  const now = Date.now();
  mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    if (streamId(url) === tag) return { items: [article("tag:google.com,2005:reader/item/00000000499602d2", now - DAY)] };
    return { itemRefs: refs([article("1234567890", now - DAY), article("tag:google.com,2005:reader/item/00000000499602d2", now - DAY)]) };
  });
  const r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
  assert.equal(r.complete, true);
  const s = await readSnapshot(p.name, r.snapshot_id);
  assert.deepEqual(s.volumes[feed].articles, [{ id: "499602d2", timestamp: now - DAY }]);
  assert.deepEqual(s.signals[feed], [{ id: "499602d2", timestamp: now - DAY }]);
  const row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows[0];
  assert.equal(row.historical.n, 1); assert.equal(row.historical.k, 1);
});

test("Archive and Clip duplicates keep first dates and normalized numeric-only hex IDs across resumed pages", async () => {
  const archive = "user/-/label/Archive", clip = "user/-/label/Clip";
  const p = profile("archive-clip-pages", [archive, clip]);
  const now = Date.now();
  const longId = "tag:google.com,2005:reader/item/0000001234567890";
  const decimalId = "78187493520";
  const signalFirst = { id: "1234567890", timestamp: now - 10 * DAY };
  const volumeFirst = { id: "1234567890", timestamp: now - 9 * DAY };
  const urls = mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [archive, clip].map(id => ({ id, type: "tag" })) };
    if (streamId(url) === archive) return url.searchParams.has("c")
      ? { items: [article(decimalId, now - 12 * DAY), article(longId, now - 3 * DAY)] }
      : { items: [article(longId, signalFirst.timestamp)], continuation: "archive-next" };
    if (streamId(url) === clip) return { items: [article(decimalId, now - DAY)] };
    assert.equal(url.pathname, "/reader/api/0/stream/items/ids");
    return url.searchParams.has("c")
      ? { itemRefs: refs([article(longId, now - 2 * DAY)]) }
      : { itemRefs: refs([article(decimalId, volumeFirst.timestamp), article(longId, now - 11 * DAY)]), continuation: "volume-next" };
  });
  let r = await refreshEvidence(p, { start_new: true, max_requests: 4 });
  const id = r.snapshot_id;
  assert.equal(r.next_cursor?.continuation, "archive-next");
  assert.deepEqual((await readSnapshot(p.name, id)).signals[feed], [signalFirst]);
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.deepEqual(r.progress.errors, []);
  assert.equal(r.next_cursor?.source_index, 1);
  assert.equal(r.next_cursor?.continuation, null);
  assert.equal(urls.at(-1)?.searchParams.get("c"), "archive-next");
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.equal(r.next_cursor?.phase, "volumes");
  assert.deepEqual((await readSnapshot(p.name, id)).signals[feed], [signalFirst]);
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.equal(r.next_cursor?.continuation, "volume-next");
  let s = await readSnapshot(p.name, id);
  assert.deepEqual(s.volumes[feed].articles, [volumeFirst]);
  assert.equal(s.volumes[feed].complete, false);
  assert.equal((await readDecisions(p.name)).observations[feed].last_complete, null);
  r = await refreshEvidence(p, { snapshot_id: id, max_requests: 1 });
  assert.equal(r.complete, true);
  assert.deepEqual(r.progress.errors, []);
  assert.equal(r.total_base_reads, 8);
  assert.equal(urls.at(-1)?.searchParams.get("c"), "volume-next");
  s = await readSnapshot(p.name, id);
  assert.deepEqual(s.signals[feed], [signalFirst]);
  assert.deepEqual(s.volumes[feed].articles, [volumeFirst]);
  assert.equal(s.source_coverage[archive], true);
  assert.equal(s.source_coverage[clip], true);
  const row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows[0];
  assert.equal(row.historical.n, 1);
  assert.equal(row.historical.k, 1);
});

test("exposure ledger retains its first timestamp across snapshots with changed dates and ID forms", async () => {
  const p = profile("stable-exposure");
  const base = Math.floor(Date.now() / 1000) * 1000;
  const longId = "tag:google.com,2005:reader/item/0000001234567890";
  const decimalId = "78187493520";
  const exposure = { id: "1234567890", timestamp: base + DAY / 2 };
  let timestamp = exposure.timestamp;
  Date.now = () => base;
  mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    if (streamId(url) === tag) return { items: [article(longId, timestamp)] };
    return { itemRefs: refs([article(decimalId, timestamp), article(longId, timestamp + 1000)]) };
  });
  try {
    let r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    assert.equal(r.complete, true);
    const firstId = r.snapshot_id;
    assert.deepEqual((await readDecisions(p.name)).observations[feed].articles, [exposure]);
    for (const [elapsed, changedTimestamp] of [[8 * DAY, base + 7 * DAY], [9 * DAY, base + DAY / 4], [10 * DAY, base - DAY]]) {
      Date.now = () => base + elapsed;
      timestamp = changedTimestamp;
      r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
      assert.equal(r.complete, true);
      assert.deepEqual(r.progress.errors, []);
      const s = await readSnapshot(p.name, r.snapshot_id);
      assert.deepEqual(s.volumes[feed].articles, [{ id: exposure.id, timestamp }]);
      assert.deepEqual(s.prospective[feed].articles, [exposure]);
      assert.deepEqual((await readDecisions(p.name)).observations[feed].articles, [exposure]);
      assert.equal(s.prospective[feed].gap_blocked, false);
      const row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows[0];
      assert.equal(row.prospective.n, 1, "changed API dates must not reset maturation");
      assert.equal(row.prospective.k, 1);
    }
    assert.deepEqual((await readSnapshot(p.name, firstId)).prospective[feed].articles, [exposure]);
  } finally { Date.now = originalNow; }
});

test("all subscriptions report newest metadata even for a never-engaged unscanned feed", async () => {
  const p = profile("newest-metadata");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const unscanned = "feed/unscanned";
  const newest = now - 3 * DAY;
  const urls = mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub(), { ...sub(), id: unscanned, title: "Unscanned" }] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    if (streamId(url) === tag) return { items: [article("positive", now - DAY)] };
    return { itemRefs: refs([article("positive", now - DAY)]) };
  }, { unreadcounts: [{ id: unscanned, count: 0, newestItemTimestampUsec: String(newest * 1000) }] });
  const r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
  assert.equal(r.complete, true);
  const s = await readSnapshot(p.name, r.snapshot_id);
  assert.equal(s.newest_item_timestamps?.[unscanned], newest);
  assert.equal(s.volumes[unscanned], undefined);
  assert.equal(urls.filter(u => u.pathname.endsWith("/stream/items/ids")).length, 1);
  const row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows.find(item => item.stream_id === unscanned);
  assert.ok(row);
  assert.equal(row.newest_item_date, new Date(newest).toISOString());
  assert.equal(row.days_since_newest, (s.started_at - newest) / DAY);
});

test("seven-day maturation separates historical and prospective cohorts and preserves exposures", async () => {
  const p = profile("cohorts");
  const base = Math.floor(Date.now() / 1000) * 1000;
  Date.now = () => base;
  const old = article("old", base - DAY);
  const exposure = article("exposure", base + DAY);
  const recent = article("recent", base + 8 * DAY);
  let round = 0;
  mock(url => {
    if (url.pathname.endsWith("subscription/list")) return { subscriptions: [sub()] };
    if (url.pathname.endsWith("tag/list")) return { tags: [{ id: tag, type: "tag" }] };
    if (streamId(url) === tag) return { items: round ? [old, exposure, recent] : [old] };
    return { itemRefs: refs(round ? [old, exposure, recent] : [old]) };
  });
  try {
    let r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    assert.equal(r.complete, true);
    assert.deepEqual((await readDecisions(p.name)).observations[feed].articles, []);
    round = 1; Date.now = () => base + 9 * DAY;
    r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    assert.equal(r.complete, true);
    let s = await readSnapshot(p.name, r.snapshot_id);
    assert.deepEqual(s.prospective[feed].articles.map(a => a.id), ["exposure", "recent"]);
    let row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows[0];
    assert.equal(row.historical.n, 3); assert.equal(row.historical.k, 3);
    assert.equal(row.prospective.n, 1); assert.equal(row.prospective.k, 1);
    // A later complete retention-limited volume must not erase earlier exposures.
    Date.now = () => base + 15 * DAY;
    mock(url => url.pathname.endsWith("subscription/list") ? { subscriptions: [sub()] } : url.pathname.endsWith("tag/list") ? { tags: [{ id: tag, type: "tag" }] } : streamId(url) === tag ? { items: [exposure, recent] } : { itemRefs: refs([recent]) });
    r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    s = await readSnapshot(p.name, r.snapshot_id);
    assert.deepEqual(s.prospective[feed].articles.map(a => a.id), ["exposure", "recent"]);
    row = evaluateSnapshot(p, s, await readDecisions(p.name)).rows[0];
    assert.equal(row.prospective.n, 2); assert.equal(row.prospective.k, 2);
    Date.now = () => base + 26 * DAY;
    r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
    s = await readSnapshot(p.name, r.snapshot_id);
    assert.equal(s.prospective[feed].gap_blocked, true, "an eleven-day successful-observation gap must block automatic promotion");
    assert.equal((await readDecisions(p.name)).observations[feed].gap_blocked, true);
  } finally { Date.now = originalNow; }
});

test("manual removal is recorded only after complete fresh membership", async () => {
  const p = profile("membership"); let response: unknown = { subscriptions: [sub(true)] };
  mock(url => url.pathname.endsWith("subscription/list") ? response : url.pathname.endsWith("tag/list") ? { tags: [{ id: tag, type: "tag" }] } : url.pathname.endsWith("/stream/items/ids") ? { itemRefs: [] } : { items: [] });
  let r = await refreshEvidence(p, { start_new: true, max_requests: 10 });
  assert.equal(r.complete, true); assert.deepEqual((await readDecisions(p.name)).membership?.ids, [feed]);
  response = { subscriptions: [sub(false)], continuation: "more" };
  r = await refreshEvidence(p, { start_new: true, max_requests: 1 });
  assert.equal(r.complete, false); assert.match(r.progress.errors.join(), /Incomplete/);
  let d = await readDecisions(p.name);
  assert.deepEqual(d.membership?.ids, [feed]); assert.equal(d.preferences[feed], undefined);
  response = { subscriptions: [sub(false)] };
  r = await refreshEvidence(p, { max_requests: 1 });
  assert.equal(r.complete, false); assert.equal(r.progress.phase, "metadata");
  d = await readDecisions(p.name);
  assert.deepEqual(d.membership?.ids, []); assert.equal(d.preferences[feed].exclude, true);
  assert.equal(d.preferences[feed].history[0].action, "manual_removal");
});
