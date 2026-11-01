import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configHash, excludedFolders, loadPriorityConfig, parsePriorityConfig, priorityProfile,
  type PriorityProfile,
} from "../src/priority/config.js";

const minimal = {
  name: "reading",
  folder: "Priority",
  positive_streams: ["user/-/state/com.google/starred", "user/-/label/Archive"],
};
const parseProfile = (overrides: Record<string, unknown> = {}) =>
  parsePriorityConfig({ profiles: [{ ...minimal, ...overrides }] })[0];
const reviewed = (profile: PriorityProfile, probability = 0.95) => ({
  ...profile,
  auto_add_enabled: true,
  promotion_probability: probability,
  calibration: {
    reviewed: true as const,
    config_hash: configHash(profile),
    promotion_probability: probability,
    reviewed_at: "2026-01-01T00:00:00.000Z",
  },
});

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("no priority config keeps the feature off without requiring HTTP", () => {
  for (const transport of [undefined, "stdio", "http"]) {
    withEnv({ INOREADER_PRIORITY_CONFIG: undefined, MCP_TRANSPORT: transport }, () => {
      assert.deepEqual(loadPriorityConfig(), []);
      assert.throws(() => priorityProfile("reading"), /Unknown or disabled priority profile/);
    });
  }
});

test("a configured file loads only under HTTP and profile lookup rejects unknown names", t => {
  const dir = mkdtempSync(join(tmpdir(), "priority-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "profiles.json");
  writeFileSync(path, JSON.stringify({ profiles: [minimal] }));
  for (const transport of [undefined, "stdio", "HTTP"]) {
    withEnv({ INOREADER_PRIORITY_CONFIG: path, MCP_TRANSPORT: transport }, () => {
      assert.throws(() => loadPriorityConfig(), /requires MCP_TRANSPORT=http and one writer process/);
    });
  }
  withEnv({ INOREADER_PRIORITY_CONFIG: path, MCP_TRANSPORT: "http" }, () => {
    assert.deepEqual(loadPriorityConfig(), [parseProfile()]);
    assert.deepEqual(priorityProfile("reading"), parseProfile());
    assert.throws(() => priorityProfile("missing"), /Unknown or disabled priority profile: missing/);
    writeFileSync(path, "{invalid JSON");
    assert.throws(() => loadPriorityConfig(), SyntaxError);
    writeFileSync(path, JSON.stringify({ profiles: [] }));
    assert.throws(() => loadPriorityConfig(), /profiles/);
  });
  withEnv({ INOREADER_PRIORITY_CONFIG: join(dir, "missing.json"), MCP_TRANSPORT: "http" }, () => {
    assert.throws(() => loadPriorityConfig(), /ENOENT/);
  });
});

test("minimal profiles default to conservative evidence requirements and disabled auto-add", () => {
  assert.deepEqual(parseProfile(), {
    ...minimal,
    excluded_topic_folders: [],
    window_months: 12,
    prior_strength: 10,
    minimum_observations: 20,
    minimum_engagements: 5,
    maturation_days: 7,
    absolute_benchmark_floor: 0.2,
    topic_multiplier: 2,
    promotion_probability: null,
    auto_add_enabled: false,
  });
  const conservative = {
    minimum_observations: 40, minimum_engagements: 10, maturation_days: 14,
    absolute_benchmark_floor: 0.4, topic_multiplier: 3,
  };
  assert.deepEqual(parseProfile(conservative), { ...parseProfile(), ...conservative });
});

for (const [field, values] of Object.entries({
  minimum_observations: [19, 20.5],
  minimum_engagements: [4, 5.5],
  maturation_days: [6, 7.5],
  absolute_benchmark_floor: [0.19, 1.01],
  topic_multiplier: [1.99, Infinity],
  prior_strength: [0, -1, Infinity],
  window_months: [0, 61, 1.5],
  promotion_probability: [0, 1],
})) {
  test(`validation rejects unsafe ${field} values`, () => {
    for (const value of values) assert.throws(() => parseProfile({ [field]: value }), new RegExp(field));
  });
}

test("profiles reject duplicate names, invalid positive signals, and unknown config keys", () => {
  assert.throws(() => parsePriorityConfig({ profiles: [minimal, minimal] }), /Duplicate priority profile name/);
  assert.throws(() => parsePriorityConfig({ profiles: [minimal, { ...minimal, name: "other", folder: " pRiOrItY " }] }), /must not share the same folder/);
  for (const stream of [
    "user/-/state/com.google/read", "user/123/state/com.google/reading-list", "user/-/label/Priority",
  ]) {
    assert.throws(() => parseProfile({ positive_streams: [stream] }), /not positive signals/);
  }
  assert.throws(() => parseProfile({ positive_streams: [] }), /positive_streams/);
  assert.throws(() => parseProfile({ positive_streams: ["same", "same"] }), /positive_streams/);
  assert.throws(() => parseProfile({ name: "../escape" }), /name/);
  assert.throws(() => parseProfile({ extra: true }), /extra/);
  assert.throws(() => parsePriorityConfig({ profiles: [minimal], extra: true }), /extra/);
});

test("topic exclusions always include the operational folder without duplicates", () => {
  assert.deepEqual(excludedFolders(parseProfile()), ["Priority"]);
  assert.deepEqual(excludedFolders(parseProfile({ excluded_topic_folders: ["News", "Priority", "News"] })), ["News", "Priority"]);
});

test("activation requires reviewed calibration matching both the model hash and probability", () => {
  const base = parseProfile();
  const valid = reviewed(base);
  assert.deepEqual(parseProfile(valid), valid);
  const invalid = [
    { ...valid, calibration: undefined },
    { ...valid, promotion_probability: null },
    { ...valid, calibration: { ...valid.calibration, reviewed: false } },
    { ...valid, calibration: { ...valid.calibration, config_hash: "0".repeat(64) } },
    { ...valid, calibration: { ...valid.calibration, promotion_probability: 0.9 } },
    { ...valid, calibration: { ...valid.calibration, reviewed_at: "not a date" } },
    { ...valid, minimum_observations: 21 },
    { ...valid, positive_streams: ["user/-/label/Other"] },
  ];
  for (const profile of invalid) assert.throws(() => parseProfile(profile));
  assert.equal(parseProfile({ promotion_probability: 0.95 }).auto_add_enabled, false);
});

test("config hashes are stable across activation flags, promotion probabilities, and calibration metadata", () => {
  const base = parseProfile();
  const hash = configHash(base);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(configHash(parseProfile()), hash);
  assert.equal(configHash({ ...base, auto_add_enabled: true }), hash);
  assert.equal(configHash(reviewed(base)), hash);
  assert.equal(configHash(reviewed(base, 0.9)), hash);
  assert.equal(configHash({ ...reviewed(base), calibration: undefined }), hash);
  assert.equal(configHash({
    ...reviewed(base),
    calibration: { ...reviewed(base).calibration, reviewed_at: "2026-02-01T00:00:00.000Z" },
  }), hash);
  for (const changes of [
    { minimum_observations: 21 }, { positive_streams: ["user/-/label/Other"] },
    { window_months: 6 }, { excluded_topic_folders: ["News"] },
  ]) assert.notEqual(configHash(parseProfile(changes)), hash);
});
