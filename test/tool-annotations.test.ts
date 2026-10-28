import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "inoreader-annotations-"));
writeFileSync(join(dir, "tokens.json"), JSON.stringify({
  access_token: "test", refresh_token: "test", expires_at: Date.now() + 3_600_000,
}));
process.env.INOREADER_CONFIG_DIR = dir;
const { connect } = await import("./wire.js");
const { DEFAULT_CONFIG_INPUT, parseTasteConfig } = await import("../src/taste/config.js");
const { TasteIndex, resetTasteIndex } = await import("../src/taste/index.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const reads = [
  "get_unread_counts", "get_articles", "get_article_ids", "search_articles",
  "get_saved_web_pages", "get_saved_items", "get_article_content",
  "list_subscriptions", "suggest_feed_cleanup", "get_uncategorized_feeds",
  "list_folders_and_tags", "analyze_feeds", "get_rate_limit_status", "get_user_info",
  "extract_classifier_data", "analyze_classifier_calibration", "recommend_audit_articles",
  "find_feed_replacement",
];
const writes = [
  "setup_auth", "batch_edit_subscriptions", "categorize_feeds", "reassign_feeds",
  "rename_folder", "manage_subscription", "manage_tags", "mark_all_read",
  "remove_saved_web_pages", "batch_manage_tags", "replace_feed",
];

test("tools/list exposes the complete audited read/write inventory", async () => {
  const { server, request } = await connect();
  try {
    const { tools } = await request("tools/list");
    assert.deepEqual(tools.map((t: any) => t.name).sort(), [...reads, ...writes].sort());
    for (const tool of tools) {
      const write = writes.includes(tool.name);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: !write,
        destructiveHint: write && !["batch_edit_subscriptions", "categorize_feeds"].includes(tool.name),
        idempotentHint: !["setup_auth", "rename_folder", "manage_subscription", "mark_all_read", "replace_feed"].includes(tool.name),
        openWorldHint: tool.name !== "get_rate_limit_status",
      }, tool.name);
      assert.ok(tool.title?.length >= 8, `${tool.name} title`);
      assert.ok(tool.description.length >= 80, `${tool.name} description`);
      assert.match(tool.description, /inoreader:\/\/usage/, `${tool.name} discoverable guidance`);
      assert.equal(tool.inputSchema.type, "object");
    }
  } finally {
    await server.close();
  }
});

test("representative reads only use read endpoints, including the content POST", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const bodies: Record<string, unknown> = {
      "GET /reader/api/0/subscription/list": { subscriptions: [] },
      "GET /reader/api/0/stream/contents/user%2F-%2Fstate%2Fcom.google%2Freading-list": { items: [] },
      "POST /reader/api/0/stream/items/contents": { items: [] },
    };
    const key = calls.at(-1)!;
    assert.ok(key in bodies, `unexpected endpoint (possible mutation): ${key}`);
    return new Response(JSON.stringify(bodies[key]), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const { server, request } = await connect();
  try {
    for (const [name, args] of [
      ["list_subscriptions", {}],
      ["get_articles", { include_total: false }],
      ["get_article_content", { article_ids: ["123"] }],
    ] as const) {
      const result = await request("tools/call", { name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const value = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, Array.isArray(value) ? { items: value } : value);
    }
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = original;
    await server.close();
  }
});

test("the taste index tools exist only when enabled, and declare all four hints", async () => {
  process.env.INOREADER_TASTE_INDEX = "on";
  await resetTasteIndex(new TasteIndex({ config: parseTasteConfig(DEFAULT_CONFIG_INPUT), dataDir: "/nonexistent", dbPath: ":memory:", threads: 1 }));
  const { server, request } = await connect();
  try {
    const { tools } = await request("tools/list");
    const taste = tools.filter((t: any) => ["similar_saved", "check_novelty", "taste_index_status", "sync_taste_index"].includes(t.name));
    assert.deepEqual(taste.map((t: any) => t.name).sort(), ["check_novelty", "similar_saved", "sync_taste_index", "taste_index_status"]);
    assert.equal(tools.length, reads.length + writes.length + 4);
    for (const t of taste) {
      assert.deepEqual(t.annotations, {
        readOnlyHint: t.name !== "sync_taste_index",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: t.name === "sync_taste_index",
      }, t.name);
      assert.match(t.description, /inoreader:\/\/usage/);
    }
    // The default configuration's tiers are the choices for `prefer`.
    assert.deepEqual(taste.find((t: any) => t.name === "similar_saved").inputSchema.properties.prefer.enum, ["highlights", "saved"]);
  } finally {
    delete process.env.INOREADER_TASTE_INDEX;
    await resetTasteIndex();
    await server.close();
  }
});
