import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFeedTitle } from "../src/tools/subscriptions.js";

/**
 * Worth testing carefully: the n8n feed organizer is instructed to apply these
 * proposed titles VERBATIM to real subscriptions, unattended. A bad rule here
 * silently renames feeds.
 */

test("strips vendor boilerplate", () => {
  const cases: Array<[string, string]> = [
    ["Jane's Blog", "Jane"],
    ["Acme Blog", "Acme"],
    ["Acme - RSS", "Acme"],
    ["Acme | Atom Feed", "Acme"],
    ["Blog on Acme", "Acme"],
    ["Posts on Acme", "Acme"],
    ["Jane's Newsletter", "Jane"],
    ["Alexander Fortin's Tech Blog", "Alexander Fortin's Tech"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeFeedTitle(input), expected, input);
  }
});

test("collapses stacked boilerplate in one pass", () => {
  assert.equal(normalizeFeedTitle("Jane's Blog RSS Feed"), "Jane");
});

test("bails out rather than destroying identity", () => {
  // Over-stripping is worse than leaving filler: the title is the only handle on
  // the feed in the organizer's UI.
  assert.equal(normalizeFeedTitle("The Blog"), "The Blog");
  assert.equal(normalizeFeedTitle("Daily Blog"), "Daily Blog");
  assert.equal(normalizeFeedTitle("Blog"), "Blog");
});

test("strips a site suffix only when it restates the real host", () => {
  assert.equal(
    normalizeFeedTitle("Some Post - example.com", "https://example.com/feed"),
    "Some Post"
  );
  // A human name after a dash is not a site suffix.
  assert.equal(
    normalizeFeedTitle("Astral Codex Ten - Scott Alexander", "https://astralcodexten.com"),
    "Astral Codex Ten - Scott Alexander"
  );
});

test("is idempotent", () => {
  for (const t of [
    "Jane's Blog",
    "Acme - RSS",
    "The Blog",
    "Bram.us",
    "Alexander Fortin's Tech Blog",
  ]) {
    const once = normalizeFeedTitle(t);
    assert.equal(normalizeFeedTitle(once), once, `not idempotent for ${t}`);
  }
});

test("normalises whitespace but leaves clean titles alone", () => {
  assert.equal(normalizeFeedTitle("  Spaced   Out  "), "Spaced Out");
  assert.equal(normalizeFeedTitle("Anil Dash"), "Anil Dash");
  assert.equal(normalizeFeedTitle("xkcd"), "xkcd");
});
