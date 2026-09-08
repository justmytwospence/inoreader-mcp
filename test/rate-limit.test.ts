import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRateHeaders } from "../src/rate-limit.js";

/** The exact header set observed from Inoreader on 2026-09-08. */
const REAL = {
  "x-reader-google-version": "555-000",
  "x-reader-limits-reset-after": "16929",
  "x-reader-user": "1003561864",
  "x-reader-zone1-limit": "2000",
  "x-reader-zone1-usage": "15",
  "x-reader-zone2-limit": "2000",
  "x-reader-zone2-usage": "127",
};

test("parses the header names Inoreader actually sends", () => {
  const p = parseRateHeaders(new Headers(REAL));
  assert.equal(p.zone1.limit, 2000);
  assert.equal(p.zone1.usage, 15);
  assert.equal(p.zone2.limit, 2000);
  assert.equal(p.zone2.usage, 127);
  assert.equal(p.resetAfterSec, 16929);
  assert.equal(p.saw, true);
});

test("still accepts the old x-reader-limits-zoneN spelling", () => {
  // The original bug: only this spelling was read, and it matches nothing Inoreader
  // sends. Kept as a fallback so being wrong about the name cannot blind us again.
  const p = parseRateHeaders(
    new Headers({ "x-reader-limits-zone2": "100", "x-reader-zone2-usage": "3" })
  );
  assert.equal(p.zone2.limit, 100);
  assert.equal(p.zone2.usage, 3);
});

test("missing headers yield null, not zero", () => {
  // limit:0 and "we were never told" are different facts. Conflating them is what
  // made a total parse failure render as a harmless-looking "unknown".
  const p = parseRateHeaders(new Headers({}));
  assert.equal(p.zone1.limit, null);
  assert.equal(p.zone1.usage, null);
  assert.equal(p.zone2.limit, null);
  assert.equal(p.resetAfterSec, null);
  assert.equal(p.saw, false, "no recognised header means do not stamp lastUpdated");
});

test("a genuine zero is preserved as zero", () => {
  const p = parseRateHeaders(new Headers({ "x-reader-zone2-usage": "0" }));
  assert.equal(p.zone2.usage, 0);
  assert.equal(p.saw, true);
});

test("unrecognised x-reader headers are captured so a rename is visible", () => {
  const p = parseRateHeaders(new Headers(REAL));
  assert.deepEqual(p.unknown, {
    "x-reader-google-version": "555-000",
    "x-reader-user": "1003561864",
  });
});

test("a future rename shows up in unknown rather than vanishing", () => {
  const p = parseRateHeaders(new Headers({ "x-reader-quota-writes-remaining": "17" }));
  assert.equal(p.zone2.limit, null);
  assert.equal(p.unknown["x-reader-quota-writes-remaining"], "17");
});

test("non-numeric values are rejected rather than becoming NaN", () => {
  const p = parseRateHeaders(new Headers({ "x-reader-zone1-limit": "unlimited" }));
  assert.equal(p.zone1.limit, null);
});

test("non-x-reader headers are ignored", () => {
  const p = parseRateHeaders(new Headers({ "content-type": "text/html", "x-other": "1" }));
  assert.deepEqual(p.unknown, {});
});
