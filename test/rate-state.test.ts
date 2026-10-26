import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "inoreader-legacy-state-"));
const statePath = join(dir, "rate-limit.json");
writeFileSync(statePath, JSON.stringify({
  zone1: { limit: 2000, usage: 100, lastUpdated: Date.now(), resetAfterSec: 3600 },
  zone2: { limit: "bad", usage: -1, lastUpdated: "bad", cooldownUntil: "bad" },
  local: { dayKey: new Date().toISOString().slice(0, 10), zone1Count: 5, zone2Count: "bad" },
}));
process.env.INOREADER_CONFIG_DIR = dir;
const { getState, noteRequest, snapshot, updateFromHeaders, zoneRemaining } = await import("../src/rate-limit.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("legacy observations remain visible but cannot fabricate fresh quota; corrupt fields are sanitized", () => {
  assert.equal(getState().zone1.usage, 100);
  assert.equal(getState().zone2.limit, null);
  assert.equal(getState().zone2.usage, null);
  assert.equal(snapshot().zone1_reads.usage_observed_at, null);
  assert.equal(zoneRemaining(1).source, "unknown");
  assert.equal(zoneRemaining(1).remaining, null);
});

test("fresh header provenance and attempt counters persist atomically in the existing state file", () => {
  updateFromHeaders(new Headers({ "x-reader-zone1-limit": "2000", "x-reader-zone1-usage": "12", "x-reader-limits-reset-after": "60" }));
  noteRequest(1); noteRequest(2);
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.zone1.usage, 12);
  assert.ok(stored.zone1.usageObservedAt);
  assert.equal(stored.zone1.attemptCount, 1);
  assert.equal(stored.zone2.attemptCount, 1);
  assert.equal(zoneRemaining(1).remaining, 1987);
  assert.equal(snapshot().zone2_writes.usage_observed_at, null);
});
