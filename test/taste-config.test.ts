import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DEFAULT_CONFIG_INPUT, STARRED_STREAM, TasteConfigError, karakeepCredentials, loadTasteConfig, loadTasteSettings, parseTasteConfig, tasteEnabled,
  type KarakeepConfig,
} from "../src/taste/config.js";

const dir = mkdtempSync(join(tmpdir(), "taste-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};

const spencer = {
  sources: [
    { name: "archive", type: "inoreader-stream", stream: "user/-/label/Archive" },
    { name: "clip", type: "inoreader-stream", stream: "user/-/label/Clip" },
    { name: "highlights", type: "inoreader-annotations" },
    { name: "karakeep", type: "karakeep", url_env: "KARAKEEP_API_URL", key_env: "KARAKEEP_API_KEY", min_words: 300 },
  ],
  tiers: [
    { name: "clip", sources: ["clip"] },
    { name: "good", sources: ["clip", "highlights", "karakeep"] },
    { name: "archive", sources: ["*"] },
  ],
  default_tier: "good",
  novelty_threshold: 0.75,
};

test("tasteEnabled is on only for on/1/true", () => {
  assert.equal(tasteEnabled({}), false);
  assert.equal(tasteEnabled({ INOREADER_TASTE_INDEX: "off" }), false);
  assert.equal(tasteEnabled({ INOREADER_TASTE_INDEX: "on" }), true);
  assert.equal(tasteEnabled({ INOREADER_TASTE_INDEX: "ON" }), true);
  assert.equal(tasteEnabled({ INOREADER_TASTE_INDEX: "1" }), true);
});

test("with no file the built-in default indexes starred and highlights", () => {
  const cfg = loadTasteConfig({});
  assert.deepEqual(cfg.sources, [
    { name: "starred", type: "inoreader-stream", stream: STARRED_STREAM },
    { name: "highlights", type: "inoreader-annotations" },
  ]);
  assert.deepEqual(cfg.tiers, [
    { name: "highlights", sources: ["highlights"] },
    { name: "saved", sources: ["starred", "highlights"] },
  ]);
  assert.equal(cfg.default_tier, "saved");
  assert.equal(cfg.novelty_threshold, 0.75);
  assert.deepEqual(parseTasteConfig(DEFAULT_CONFIG_INPUT), cfg);
});

test("a Spencer-shaped file parses, with * expanded to every source", () => {
  const cfg = loadTasteConfig({ INOREADER_TASTE_CONFIG: file("spencer.json", spencer) });
  assert.deepEqual(cfg.sources.map((s) => s.name), ["archive", "clip", "highlights", "karakeep"]);
  assert.deepEqual(cfg.tiers.map((t) => t.name), ["clip", "good", "archive"]);
  assert.deepEqual(cfg.tiers[2].sources, ["archive", "clip", "highlights", "karakeep"]);
  assert.equal(cfg.default_tier, "good");
  const kk = cfg.sources[3] as KarakeepConfig;
  assert.equal(kk.min_words, 300);
  assert.equal(kk.use_reader_view, true);
});

test("a minimal custom file gets one tier over everything and the widest as default", () => {
  const cfg = parseTasteConfig({ sources: [{ name: "reads", type: "inoreader-stream", stream: "user/-/label/Reads" }] });
  assert.deepEqual(cfg.tiers, [{ name: "all", sources: ["reads"] }]);
  assert.equal(cfg.default_tier, "all");
  const two = parseTasteConfig({
    sources: [{ name: "a", type: "inoreader-annotations" }, { name: "b", type: "inoreader-stream", stream: "s" }],
    tiers: [{ name: "narrow", sources: ["a"] }, { name: "wide", sources: ["*"] }],
  });
  assert.equal(two.default_tier, "wide");
});

const invalid: Array<[string, unknown, RegExp]> = [
  ["an unknown source in a tier", { ...spencer, tiers: [{ name: "x", sources: ["nope"] }], default_tier: "x" }, /tier "x" lists unknown source "nope"/],
  ["duplicate source names", { ...spencer, sources: [spencer.sources[0], spencer.sources[0]] , tiers: [{ name: "x", sources: ["*"] }], default_tier: "x" }, /duplicate source name "archive"/],
  ["duplicate tier names", { ...spencer, tiers: [{ name: "a", sources: ["*"] }, { name: "a", sources: ["*"] }], default_tier: "a" }, /duplicate tier name "a"/],
  ["an unknown default tier", { ...spencer, default_tier: "best" }, /default_tier "best" is not a tier/],
  ["no sources", { sources: [] }, /sources/],
  ["an unknown source type", { sources: [{ name: "a", type: "instapaper" }] }, /sources/],
  ["a literal Karakeep key in the file", { sources: [{ ...spencer.sources[3], key: "secret" }] }, /key/],
  ["a literal Karakeep url in the file", { sources: [{ ...spencer.sources[3], url: "http://x" }] }, /url/],
  ["a bad name", { sources: [{ name: "has space", type: "inoreader-annotations" }] }, /sources\.0\.name/],
  ["a bad env name", { sources: [{ ...spencer.sources[3], key_env: "1 bad" }] }, /key_env/],
  ["a threshold of zero", { ...spencer, novelty_threshold: 0 }, /novelty_threshold/],
  ["an unknown top-level key", { ...spencer, extra: true }, /extra/],
  ["an empty tier", { ...spencer, tiers: [{ name: "x", sources: [] }] }, /tiers/],
];
for (const [name, input, pattern] of invalid) {
  test(`validation rejects ${name}`, () => {
    assert.throws(() => parseTasteConfig(input), (e: unknown) => e instanceof TasteConfigError && pattern.test(e.message));
  });
}

test("every problem is reported at once", () => {
  assert.throws(
    () => parseTasteConfig({ ...spencer, tiers: [{ name: "x", sources: ["nope", "alsono"] }], default_tier: "y" }),
    (e: unknown) => e instanceof Error && /nope/.test(e.message) && /alsono/.test(e.message) && /default_tier "y"/.test(e.message),
  );
});

test("an unreadable or malformed file fails with the path in the message", () => {
  assert.throws(() => loadTasteConfig({ INOREADER_TASTE_CONFIG: join(dir, "missing.json") }), /cannot read .*missing\.json/);
  assert.throws(() => loadTasteConfig({ INOREADER_TASTE_CONFIG: file("bad.json", "{nope") }), /not valid JSON/);
  assert.throws(() => loadTasteConfig({ INOREADER_TASTE_CONFIG: file("bad2.json", { sources: [] }) }), /bad2\.json/);
});

test("Karakeep credentials come only from the environment variables the file names", () => {
  const kk = parseTasteConfig(spencer).sources[3] as KarakeepConfig;
  assert.deepEqual(karakeepCredentials(kk, { KARAKEEP_API_URL: "http://karakeep:3000/", KARAKEEP_API_KEY: "k" }), { url: "http://karakeep:3000", key: "k" });
  // Not read from anywhere else, including a differently named variable.
  assert.throws(() => karakeepCredentials(kk, { OTHER_URL: "http://x", OTHER_KEY: "k" }), /KARAKEEP_API_URL, KARAKEEP_API_KEY/);
  assert.throws(() => karakeepCredentials(kk, { KARAKEEP_API_URL: "http://x" }), /KARAKEEP_API_KEY/);
  const renamed = parseTasteConfig({ sources: [{ ...spencer.sources[3], url_env: "MY_URL", key_env: "MY_KEY" }] }).sources[0] as KarakeepConfig;
  assert.deepEqual(karakeepCredentials(renamed, { MY_URL: "http://z", MY_KEY: "q", KARAKEEP_API_KEY: "wrong" }), { url: "http://z", key: "q" });
});

test("settings locate the index under the config dir and validate threads", () => {
  const s = loadTasteSettings({ INOREADER_CONFIG_DIR: "/data", INOREADER_TASTE_MODEL_DIR: "/app/models" });
  assert.equal(s.dbPath, "/data/taste/index.sqlite");
  assert.equal(s.dataDir, "/data/taste");
  assert.equal(s.modelDir, "/app/models");
  assert.equal(s.threads, 1);
  assert.equal(loadTasteSettings({ INOREADER_TASTE_THREADS: "2" }).threads, 2);
  assert.equal(loadTasteSettings({}).modelDir, undefined);
  assert.throws(() => loadTasteSettings({ INOREADER_TASTE_THREADS: "0" }), /THREADS/);
  assert.throws(() => loadTasteSettings({ INOREADER_TASTE_THREADS: "many" }), /THREADS/);
});

test("exclude_domains: any source may list domains; they are normalized and validated", () => {
  const cfg = parseTasteConfig({
    sources: [
      { name: "a", type: "inoreader-stream", stream: "user/-/label/A", exclude_domains: ["WWW.GitHub.com"] },
      { name: "h", type: "inoreader-annotations", exclude_domains: ["x.com"] },
      { name: "k", type: "karakeep", url_env: "U", key_env: "K", exclude_domains: ["reddit.com", "youtube.com"] },
    ],
  });
  assert.deepEqual(cfg.sources.map((s) => s.exclude_domains), [["github.com"], ["x.com"], ["reddit.com", "youtube.com"]]);
  assert.throws(
    () => parseTasteConfig({ sources: [{ name: "a", type: "inoreader-stream", stream: "s", exclude_domains: ["not a domain"] }] }),
    /sources\.0\.exclude_domains\.0: "not a domain" is not a domain name/,
  );
});
