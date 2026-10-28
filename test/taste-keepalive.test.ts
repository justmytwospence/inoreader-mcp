import assert from "node:assert/strict";
import { after, afterEach, test, type TestContext } from "node:test";
import { FakeInoreader, cleanup, installFetch, para, seededIndex, setZone1 } from "./taste-fixtures.js";

process.env.INOREADER_CLIENT_ID = "client";
process.env.INOREADER_CLIENT_SECRET = "secret";
process.env.NTFY_URL = "http://ntfy.test";
process.env.NTFY_TOPIC = "alerts";
delete process.env.NTFY_TOKEN;
delete process.env.INOREADER_KEEPALIVE_HOURS;

const { startKeepalive } = await import("../src/keepalive.js");
const { parseTasteConfig } = await import("../src/taste/config.js");
const { resetTasteIndex } = await import("../src/taste/index.js");
const { META_LAST_SYNC } = await import("../src/taste/sync.js");

after(async () => {
  await resetTasteIndex();
  cleanup();
});
afterEach(async () => {
  delete process.env.INOREADER_TASTE_INDEX;
  await resetTasteIndex();
});

const config = parseTasteConfig({ sources: [{ name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" }] });

/** Inoreader with a token endpoint, plus an ntfy sink; records the order of requests. */
function world(opts: { refreshStatus?: number } = {}) {
  const ino = new FakeInoreader();
  ino.streams.set("user/-/label/Archive", [{ id: "9001", url: "https://x.example/kept", title: "Kept", html: para(60, "kept") }]);
  const events: string[] = [];
  const ntfy: Array<{ title: string; body: string }> = [];
  const restoreInoreader = installFetch(ino);
  const routed = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname === "/oauth2/token") {
      events.push("refresh");
      return opts.refreshStatus && opts.refreshStatus >= 400
        ? new Response("invalid_grant", { status: opts.refreshStatus })
        : new Response(JSON.stringify({ access_token: "new", refresh_token: "newer", expires_in: 86400 }), { headers: { "content-type": "application/json" } });
    }
    if (url.host === "ntfy.test") {
      ntfy.push({ title: String((init?.headers as Record<string, string>).Title), body: String(init?.body) });
      return new Response("ok");
    }
    if (url.pathname.startsWith("/reader/api/0/stream/")) events.push("taste read");
    return routed(input, init);
  }) as typeof fetch;
  return { ino, events, ntfy, restore: () => { globalThis.fetch = routed; restoreInoreader(); } };
}

/** Runs the first keepalive tick (60 s after start) and waits for it to finish. */
async function firstTick(t: TestContext, done: () => boolean) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  startKeepalive();
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(done(), "the tick finished");
}

test("the tick refreshes the tokens, then syncs the taste index in the same tick", async (t) => {
  const w = world();
  setZone1(2000, 0);
  process.env.INOREADER_TASTE_INDEX = "on";
  const { index, store } = await seededIndex(config, [], { synced: false });
  await resetTasteIndex(index);
  const log = t.mock.method(console, "error", () => {});
  try {
    await firstTick(t, () => store.getJson<{ outcome?: string } | null>(META_LAST_SYNC, null)?.outcome === "ok");
    assert.deepEqual(w.events.slice(0, 2), ["refresh", "taste read"], "refresh first, then the sync's reads");
    assert.equal(store.itemCount(), 1);
    assert.deepEqual(w.ntfy, []);
    assert.ok(log.mock.calls.some((c) => /taste: sync ok: 1 items/.test(String(c.arguments[0]))));
  } finally {
    w.restore();
  }
});

test("a taste sync that throws is logged and never reaches the refresh or its alert", async (t) => {
  const w = world();
  process.env.INOREADER_TASTE_INDEX = "on";
  const { index } = await seededIndex(config, []);
  let called = 0;
  index.sync = async () => {
    called++;
    throw new Error("sqlite exploded");
  };
  await resetTasteIndex(index);
  const log = t.mock.method(console, "error", () => {});
  try {
    await firstTick(t, () => log.mock.calls.some((c) => /taste: sync failed/.test(String(c.arguments[0]))));
    assert.equal(called, 1);
    assert.deepEqual(w.events, ["refresh"]);
    assert.deepEqual(w.ntfy, [], "a sync failure sends no token alert");
    assert.ok(log.mock.calls.some((c) => /keepalive: refreshed tokens/.test(String(c.arguments[0]))));
  } finally {
    w.restore();
  }
});

test("when the refresh fails the alert goes out as before and the sync is skipped, not attempted", async (t) => {
  const w = world({ refreshStatus: 400 });
  process.env.INOREADER_TASTE_INDEX = "on";
  const { index, store } = await seededIndex(config, []);
  await resetTasteIndex(index);
  t.mock.method(console, "error", () => {});
  try {
    await firstTick(t, () => w.ntfy.length > 0 && store.getJson<{ outcome?: string } | null>(META_LAST_SYNC, null)?.outcome === "skipped");
    assert.equal(w.ntfy.length, 1);
    assert.equal(w.ntfy[0].title, "Inoreader token refresh failed");
    assert.match(w.ntfy[0].body, /Re-authorize with the setup_auth tool/);
    assert.ok(!w.events.includes("taste read"), "no Inoreader reads were made");
    assert.match(store.getJson<{ reason: string }>(META_LAST_SYNC, { reason: "" }).reason, /token refresh did not succeed/);
  } finally {
    w.restore();
  }
});

test("without the taste index the tick is only the refresh", async (t) => {
  const w = world();
  const log = t.mock.method(console, "error", () => {});
  try {
    await firstTick(t, () => log.mock.calls.some((c) => /keepalive: refreshed tokens/.test(String(c.arguments[0]))));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.events, ["refresh"]);
    assert.ok(!log.mock.calls.some((c) => /taste/.test(String(c.arguments[0]))));
  } finally {
    w.restore();
  }
});
