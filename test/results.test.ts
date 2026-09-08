import { test } from "node:test";
import assert from "node:assert/strict";
import { BulkWriteResultSchema, renderFolderWriteResult } from "../src/results.js";
import type { FolderWriteReport } from "../src/verify.js";

const base = {
  verification: "read-back" as const,
  rounds: 1,
};

test("a reconciling result parses", () => {
  const r = BulkWriteResultSchema.parse({
    ...base,
    intended: 10,
    verified: 7,
    unverified: 2,
    failed: 1,
    not_attempted: 0,
  });
  assert.equal(r.verified, 7);
});

test("counts that do not sum to intended are rejected", () => {
  assert.throws(
    () =>
      BulkWriteResultSchema.parse({
        ...base,
        intended: 42,
        verified: 21,
        unverified: 0,
        failed: 0,
        not_attempted: 0,
      } as never),
    /do not reconcile/,
    "21 accounted for against 42 intended must not parse"
  );
});

test("the invariant is arithmetic, not clairvoyance", () => {
  // Worth stating plainly so nobody mistakes this guard for more than it is.
  // {intended: 42, verified: 42} reconciles perfectly and parses fine -- it is
  // exactly what the old tool emitted while 21 moves had actually happened.
  //
  // The schema cannot detect a well-formed lie. What prevents that lie is that
  // renderFolderWriteResult derives every count from the verified item list, so
  // there is no code path left that can produce 42 from a 21-item result. The
  // invariant catches the next person who reintroduces a hand-rolled tally and
  // gets the arithmetic wrong on the way.
  assert.doesNotThrow(() =>
    BulkWriteResultSchema.parse({
      ...base,
      intended: 42,
      verified: 42,
      unverified: 0,
      failed: 0,
      not_attempted: 0,
    } as never)
  );
});

test("optimistic counting is caught for any random split", () => {
  for (let i = 0; i < 200; i++) {
    const v = Math.floor(Math.random() * 20);
    const u = Math.floor(Math.random() * 20);
    const f = Math.floor(Math.random() * 20);
    const n = Math.floor(Math.random() * 20);
    const good = { ...base, intended: v + u + f + n, verified: v, unverified: u, failed: f, not_attempted: n };
    assert.doesNotThrow(() => BulkWriteResultSchema.parse(good));
    const bad = { ...good, intended: good.intended + 1 };
    assert.throws(() => BulkWriteResultSchema.parse(bad), /do not reconcile/);
  }
});

function report(over: Partial<FolderWriteReport> = {}): FolderWriteReport {
  return {
    intended: 2,
    verified: 2,
    unverified: 0,
    failed: 0,
    not_attempted: 0,
    rounds: 1,
    verification: "read-back",
    by_folder: { AI: { verified: 2, unverified: 0, failed: 0 } },
    items: [
      { stream_id: "a", folder: "AI", status: "verified", in_destination: true, attempts: 1 },
      { stream_id: "b", folder: "AI", status: "verified", in_destination: true, attempts: 1 },
    ],
    ...over,
  };
}

test("a fully applied write is not an error", () => {
  const res = renderFolderWriteResult(report());
  assert.equal(res.isError, false);
  assert.ok(!JSON.parse(res.content[0].text).not_applied);
});

test("a shortfall sets isError and lists what did not land", () => {
  const res = renderFolderWriteResult(
    report({
      verified: 1,
      unverified: 1,
      items: [
        { stream_id: "a", folder: "AI", status: "verified", in_destination: true, attempts: 1 },
        {
          stream_id: "b",
          folder: "AI",
          status: "unverified",
          in_destination: false,
          still_in_source: true,
          attempts: 2,
        },
      ],
      by_folder: { AI: { verified: 1, unverified: 1, failed: 0 } },
    })
  );
  assert.equal(res.isError, true, "a model must not be able to read a shortfall as success");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.not_applied.length, 1);
  assert.equal(body.not_applied[0].stream_id, "b");
  assert.equal(body.not_applied[0].still_in_source, true);
});

test("an unverifiable write warns loudly and is treated as an error", () => {
  const res = renderFolderWriteResult(
    report({
      verified: 0,
      unverified: 2,
      verification: "none",
      verify_error: "network down",
      items: report().items.map((i) => ({ ...i, status: "unverified" as const, in_destination: false })),
      by_folder: { AI: { verified: 0, unverified: 2, failed: 0 } },
    })
  );
  assert.equal(res.isError, true);
  assert.match(JSON.parse(res.content[0].text).warning, /could NOT be verified/);
});
