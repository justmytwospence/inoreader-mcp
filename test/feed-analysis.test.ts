import assert from "node:assert/strict";
import { test } from "node:test";
import { countEngagement, fitCategoryPriors, feedPosterior, type FeedCounts } from "../src/feed-analysis.js";
import type { ArticleItem } from "../src/types.js";

const feed = (stream_id: string, k: number, n: number, folders = ["Topic"]): FeedCounts => ({ stream_id, k, n, folders });
const item = (id: string, streamId?: string) => ({ id, ...(streamId ? { origin: { streamId } } : {}) }) as ArticleItem;
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("positive stream union deduplicates IDs across and within streams", () => {
  const counts = countEngagement([item("a", "feed/a"), item("a", "feed/a"), item("b", "feed/a"), item("c", "feed/b"), item("d"), item("d", "feed/b")]);
  assert.deepEqual([...counts], [["feed/a", 2], ["feed/b", 2]]);
});

test("category pooling uses at least two engaged feeds and excludes operational folders", () => {
  const report = fitCategoryPriors([
    feed("a", 8, 10, ["A", "Operational"]), feed("b", 6, 10, ["A"]),
    feed("c", 1, 10, ["B", "Operational"]),
  ], ["Operational"], 10);
  near(report.global.rate, 0.5);
  near(report.by_category.A.rate, 0.7);
  near(report.by_category.B.rate, 0.5);
  assert.deepEqual(report.fallback_categories, ["B"]);
  assert.equal(report.by_category.Operational, undefined);
});

test("operational-folder exclusions use the same trimmed case-insensitive identity as membership", () => {
  const report = fitCategoryPriors([
    feed("a", 8, 10, ["Topic", " Must read "]), feed("b", 6, 10, ["Topic", "MUST READ"]),
  ], ["Must Read"], 10);
  assert.deepEqual(Object.keys(report.by_category), ["Topic"]);
});

test("incomplete and inconsistent counts cannot influence empirical priors", () => {
  const report = fitCategoryPriors([
    feed("a", 2, 10), feed("b", 4, 10),
    { ...feed("c", 99, 100), volume_complete: false },
    { ...feed("d", 99, 100), engagement_complete: false },
    feed("invalid", 11, 10), feed("unsampled", 0, 0),
  ], [], 10);
  near(report.global.rate, 0.3);
  near(report.by_category.Topic.rate, 0.3);
  assert.equal(report.global_observations, 20);
});

test("Jeffreys stabilization keeps empty and zero/one rate priors finite", () => {
  for (const [feeds, expected] of [
    [[], 0.5], [[feed("zero", 0, 10)], 0.5 / 11],
    [[feed("one", 10, 10), feed("two", 10, 10)], 20.5 / 21],
  ] as Array<[FeedCounts[], number]>) {
    const report = fitCategoryPriors(feeds, [], 10);
    near(report.global.rate, expected);
    assert.equal(report.global_stabilized, true);
    assert.ok(report.global.alpha > 0 && report.global.beta > 0);
    near(report.global.alpha + report.global.beta, 10);
  }
  const report = fitCategoryPriors([feed("a", 1, 1), feed("b", 1, 1)], [], 10);
  assert.deepEqual(report.stabilized_categories, ["Topic"]);
  const huge = fitCategoryPriors([feed("huge", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)], [], 10);
  assert.ok(huge.global.beta > 0, "boundary complement must not round to zero");
});

test("posterior shrinks small samples and returns exact equal-tailed bounds", () => {
  const small = feedPosterior(1, 1, { alpha: 1, beta: 9 });
  near(small.alpha, 2); near(small.beta, 9); near(small.mean, 2 / 11);
  assert.ok(small.ci_low > 0 && small.ci_low < small.mean && small.ci_high > small.mean && small.ci_high < 1);
  const uniform = feedPosterior(0, 0, { alpha: 1, beta: 1 });
  near(uniform.ci_low, 0.05); near(uniform.ci_high, 0.95);
  const noEngagement = feedPosterior(0, 20, { alpha: 1, beta: 9 });
  assert.ok(noEngagement.mean > 0 && noEngagement.ci_low > 0);
});

test("invalid counts, shape parameters and strengths fail closed", () => {
  for (const [k, n] of [[-1, 10], [11, 10], [1.5, 10], [0, NaN]]) {
    assert.throws(() => feedPosterior(k, n, { alpha: 1, beta: 1 }), RangeError);
  }
  assert.throws(() => feedPosterior(1, 10, { alpha: 0, beta: 1 }), RangeError);
  for (const strength of [0, -1, Infinity, NaN]) assert.throws(() => fitCategoryPriors([], [], strength), RangeError);
});
