import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The regression test for the 2026-10 stale subscription list.
 *
 * apiGet kept every response in a module-level Map with no expiry. That was
 * invisible while mcpjungle spawned a process per tool call, but in the
 * long-lived HTTP server it served the same subscription list for eight days,
 * so feeds added in Inoreader's own apps never reached the organize workflow.
 * Two reads in one process, with the server's answer changing in between, must
 * both see the server's current answer.
 */

// auth.ts and rate-limit.ts read INOREADER_CONFIG_DIR at module load, so set it
// before importing api.ts.
const dir = mkdtempSync(join(tmpdir(), "inoreader-mcp-test-"));
writeFileSync(
  join(dir, "tokens.json"),
  JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3_600_000 })
);
process.env.INOREADER_CONFIG_DIR = dir;
const { apiGet, apiPost } = await import("../src/api.js");

function serve(bodies: unknown[]): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(n, bodies.length - 1)];
    n += 1;
    const isText = typeof body === "string";
    return new Response(isText ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": isText ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;
  return { calls: () => n };
}

test("a repeated read returns the server's current answer, not a remembered one", async () => {
  const server = serve([{ subscriptions: [{ id: "a" }] }, { subscriptions: [{ id: "a" }, { id: "b" }] }]);

  const first = await apiGet<{ subscriptions: unknown[] }>("/reader/api/0/subscription/list", { output: "json" });
  const second = await apiGet<{ subscriptions: unknown[] }>("/reader/api/0/subscription/list", { output: "json" });

  assert.equal(server.calls(), 2, "each read must reach Inoreader");
  assert.equal(first.subscriptions.length, 1);
  assert.equal(second.subscriptions.length, 2, "a feed added between reads must be visible");
});

test("a read after a write still reaches the server", async () => {
  const server = serve([{ v: 1 }, "OK", { v: 2 }]);

  await apiGet("/reader/api/0/unread-count", { output: "json" });
  await apiPost("/reader/api/0/subscription/edit", { ac: "edit", s: "feed/x", t: "y" });
  const after = await apiGet<{ v: number }>("/reader/api/0/unread-count", { output: "json" });

  assert.equal(server.calls(), 3);
  assert.equal(after.v, 2);
});
