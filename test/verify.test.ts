import { test } from "node:test";
import assert from "node:assert/strict";
import { diffIntents, type FolderIntent } from "../src/verify.js";

/**
 * The regression suite for the 2026-09-08 incident.
 *
 * reassign_feeds reported 42 of 42 successes for a batch that had moved 21 feeds.
 * The failure had two distinct shapes and the old code could see neither, because
 * it never looked at server state at all: it counted HTTP 2xx responses.
 */

const state = (entries: Array<[string, string[]]>) =>
  new Map(entries.map(([id, labels]) => [id, new Set(labels.map((l) => l.toLowerCase()))]));

test("all intents satisfied", () => {
  const intents: FolderIntent[] = [
    { streamId: "a", folder: "AI" },
    { streamId: "b", folder: "AI" },
  ];
  const { satisfied, shortfall } = diffIntents(intents, state([["a", ["ai"]], ["b", ["ai"]]]));
  assert.equal(satisfied.length, 2);
  assert.equal(shortfall.length, 0);
});

test("nothing applied", () => {
  const intents: FolderIntent[] = [{ streamId: "a", folder: "AI" }];
  const { satisfied, shortfall } = diffIntents(intents, state([["a", ["data science"]]]));
  assert.equal(satisfied.length, 0);
  assert.deepEqual(shortfall, intents);
});

test("THE INCIDENT: added to destination but still in source counts as shortfall", () => {
  // Fourteen feeds ended in both folders. Inoreader answered 200 to a combined
  // a=/r= edit and honoured only the add. A checker that looks at the destination
  // alone calls this a success -- which is exactly what shipped.
  const intents: FolderIntent[] = [{ streamId: "a", folder: "AI" }];
  const observed = state([["a", ["ai", "data science"]]]);

  const withMove = diffIntents(intents, observed, "Data Science");
  assert.equal(withMove.satisfied.length, 0, "half-applied move must not count as satisfied");
  assert.equal(withMove.shortfall.length, 1);

  // Without a removeFrom (categorize_feeds, an add-only operation) the same state
  // IS satisfied -- the feed is where it was asked to be.
  const addOnly = diffIntents(intents, observed);
  assert.equal(addOnly.satisfied.length, 1);
});

test("half the batch applied", () => {
  const intents: FolderIntent[] = [
    { streamId: "a", folder: "AI" },
    { streamId: "b", folder: "AI" },
    { streamId: "c", folder: "AI" },
    { streamId: "d", folder: "AI" },
  ];
  const observed = state([
    ["a", ["ai"]],
    ["b", ["ai", "data science"]], // added, not removed
    ["c", ["data science"]], // never moved
    ["d", ["ai"]],
  ]);
  const { satisfied, shortfall } = diffIntents(intents, observed, "Data Science");
  assert.deepEqual(satisfied.map((i) => i.streamId), ["a", "d"]);
  assert.deepEqual(shortfall.map((i) => i.streamId), ["b", "c"]);
});

test("a feed absent from the subscription list is shortfall, never satisfied", () => {
  // Unsubscribed mid-run, or a stream_id that never existed. Inoreader returns 200
  // for an edit to a feed that does not exist, so this must not be trusted.
  const intents: FolderIntent[] = [{ streamId: "ghost", folder: "AI" }];
  const { satisfied, shortfall } = diffIntents(intents, state([["a", ["ai"]]]));
  assert.equal(satisfied.length, 0);
  assert.equal(shortfall.length, 1);
});

test("folder comparison is case- and whitespace-insensitive", () => {
  const intents: FolderIntent[] = [{ streamId: "a", folder: "  data science  " }];
  const { satisfied } = diffIntents(intents, state([["a", ["Data Science"]]]));
  assert.equal(satisfied.length, 1);
});

test("every intent lands in exactly one bucket", () => {
  const intents: FolderIntent[] = Array.from({ length: 25 }, (_, i) => ({
    streamId: `f${i}`,
    folder: i % 2 ? "AI" : "Tech",
  }));
  const observed = state(intents.filter((_, i) => i % 3 === 0).map((i) => [i.streamId, [i.folder]]));
  const { satisfied, shortfall } = diffIntents(intents, observed);
  assert.equal(satisfied.length + shortfall.length, intents.length);
});
