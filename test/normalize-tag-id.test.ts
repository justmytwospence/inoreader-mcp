import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTagId } from "../src/verify-tags.js";

/**
 * Regression test for a false negative found in live testing: a tag that had
 * applied perfectly was reported `unverified`, because the request form and the
 * stored form of the same tag were compared as raw strings.
 */

test("the request form and the stored form of one tag agree", () => {
  assert.equal(
    normalizeTagId("user/-/label/ZZTagTest"),
    normalizeTagId("user/1003561864/label/ZZTagTest")
  );
});

test("system state tags normalise too", () => {
  assert.equal(
    normalizeTagId("user/-/state/com.google/read"),
    normalizeTagId("user/1003561864/state/com.google/read")
  );
  assert.equal(
    normalizeTagId("user/9999/state/com.google/starred"),
    "user/-/state/com.google/starred"
  );
});

test("labels containing slashes survive", () => {
  // Only the user segment is rewritten, never the rest of the path.
  assert.equal(
    normalizeTagId("user/1003561864/label/read/worth-it"),
    "user/-/label/read/worth-it"
  );
});

test("distinct labels stay distinct", () => {
  assert.notEqual(
    normalizeTagId("user/1/label/AI"),
    normalizeTagId("user/1/label/Tech")
  );
});

test("already-canonical ids are unchanged and the function is idempotent", () => {
  const canonical = "user/-/label/AI";
  assert.equal(normalizeTagId(canonical), canonical);
  assert.equal(normalizeTagId(normalizeTagId("user/42/label/AI")), "user/-/label/AI");
});

test("non-user ids pass through untouched", () => {
  assert.equal(normalizeTagId("tag:google.com,2005:reader/item/abc"), "tag:google.com,2005:reader/item/abc");
});
