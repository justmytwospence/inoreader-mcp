import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItemId } from "../src/verify-tags.js";

/**
 * Inoreader returns short decimal ids from stream/items/ids and long-form ids from
 * stream/items/contents. If those do not compare equal, tag verification reports
 * false "not applied" and burns Zone 2 writes reconciling edits that already worked.
 */

test("long and short forms of the same id agree", () => {
  const short = "1234567890"; // 0x499602d2
  const long = "tag:google.com,2005:reader/item/00000000499602d2";
  assert.equal(normalizeItemId(short), normalizeItemId(long));
  assert.equal(normalizeItemId(short), "499602d2");
});

test("leading zeros are insignificant", () => {
  assert.equal(
    normalizeItemId("tag:google.com,2005:reader/item/0000000000000001"),
    normalizeItemId("tag:google.com,2005:reader/item/1")
  );
});

test("hex case is insignificant", () => {
  assert.equal(
    normalizeItemId("tag:google.com,2005:reader/item/00000000ABCDEF12"),
    normalizeItemId("tag:google.com,2005:reader/item/00000000abcdef12")
  );
});

test("distinct ids stay distinct", () => {
  assert.notEqual(normalizeItemId("1234567890"), normalizeItemId("1234567891"));
});

test("large ids beyond Number precision survive", () => {
  // 2^53 + 1: parseInt would lose this, BigInt does not.
  const decimal = "9007199254740993";
  assert.equal(normalizeItemId(decimal), BigInt(decimal).toString(16));
});

test("unrecognised shapes pass through lowercased rather than throwing", () => {
  assert.equal(normalizeItemId("not-an-id"), "not-an-id");
  assert.equal(normalizeItemId("Weird:Thing"), "weird:thing");
});
