import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePriorityConfig, configHash } from "../src/priority/config.js";
import { emptyDecisions, type PrioritySnapshot } from "../src/priority/store.js";
import { calibrationReport, evaluateSnapshot, policyReport } from "../src/priority/policy.js";
import { betaCdf } from "../src/statistics/beta.js";
import { DAY, weekKey } from "../src/priority/evidence.js";

const p = parsePriorityConfig({ profiles: [{ name: "shadow", folder: "Priority", positive_streams: ["user/-/state/com.google/starred"] }] })[0];
const now = Date.UTC(2026, 9, 26, 12);
const article = (id: string, timestamp: number) => ({ id, timestamp });
function snapshot(id: string, at: number, n = 50, k = 40): PrioritySnapshot {
  const articles = Array.from({ length: n }, (_, i) => article(`${id}-a${i}`, at - 8 * DAY));
  const baseline = Array.from({ length: 1000 }, (_, i) => article(`${id}-b${i}`, at - 8 * DAY));
  return { version: 1, id, config_hash: configHash(p), model: "category-beta-v1", started_at: at, completed_at: at + 1, cutoff: at - 365 * DAY, phase: "complete", source_index: 1, feed_index: 2, continuation: null, base_reads: 5, subscriptions: ["feed/a", "feed/b"].map(id => ({ id, title: id, url: id, htmlUrl: "", categories: [{ id: "user/-/label/Topic", label: "Topic" }, { id: "user/-/label/Priority", label: "Priority" }] })), signal_sources: p.positive_streams, source_coverage: { [p.positive_streams[0]]: true }, signals: { "feed/a": articles.slice(0, k), "feed/b": baseline.slice(0, 1) }, feed_ids: ["feed/a", "feed/b"], volumes: { "feed/a": { articles, complete: true, observed_at: at }, "feed/b": { articles: baseline, complete: true, observed_at: at } }, prospective: { "feed/a": { articles, first_observed: at - 100 * DAY, gap_blocked: false }, "feed/b": { articles: baseline, first_observed: at - 100 * DAY, gap_blocked: false } }, membership: [], errors: [] };
}
test("exact forward posterior/benchmark exclude operational folder; historical context cannot promote", () => {
  const s = snapshot("one", now), d = emptyDecisions();
  const report = evaluateSnapshot(p, s, d), row = report.rows[0];
  assert.equal(report.prospective_priors.by_category.Priority, undefined);
  assert.equal(row.prospective.benchmark, 0.2);
  assert.equal(row.prospective.probability_above, 1 - betaCdf(0.2, row.prospective.posterior!.alpha, row.prospective.posterior!.beta));
  assert.equal(row.evidence_eligible, true); assert.equal(row.qualifies, false);
  assert.ok(row.reasons.includes("uncalibrated_probability"));
  s.prospective["feed/a"].articles = [];
  assert.equal(evaluateSnapshot(p, s, d).rows[0].evidence_eligible, false);
});
test("operational and explicitly excluded folders are case-insensitive and trimmed in pooling and resolution", () => {
  const profile = { ...p, excluded_topic_folders: [" Control "] }, s = snapshot("mixed-case", now);
  s.config_hash = configHash(profile);
  for (const sub of s.subscriptions) sub.categories = [{ id: "topic", label: "Topic" }, { id: "operational", label: " pRiOrItY " }, { id: "control", label: "CONTROL" }];
  const report = evaluateSnapshot(profile, s, emptyDecisions());
  assert.deepEqual(Object.keys(report.prospective_priors.by_category), ["Topic"]);
  assert.deepEqual(Object.keys(report.historical_priors.by_category), ["Topic"]);
  assert.equal(report.rows[0].prospective.global_fallback, false);
  assert.equal(report.rows[0].prospective.benchmark, 0.2);
});
test("seven-day maturity, inconsistent counts, incomplete sources and >10day gap block eligibility", () => {
  const d = emptyDecisions();
  for (const mutate of [
    (s: PrioritySnapshot) => { s.prospective["feed/a"].articles.forEach(a => a.timestamp = now - 6 * DAY); s.signals["feed/a"] = []; },
    (s: PrioritySnapshot) => { s.source_coverage[p.positive_streams[0]] = false; },
    (s: PrioritySnapshot) => { s.prospective["feed/a"].gap_blocked = true; },
    (s: PrioritySnapshot) => { s.signals["feed/a"].push(article("missing", now - 8 * DAY)); },
    (s: PrioritySnapshot) => { s.phase = "volumes"; s.completed_at = null; },
  ]) { const s = snapshot("one", now); mutate(s); assert.equal(evaluateSnapshot(p, s, d).rows[0].evidence_eligible, false); }
});
test("two successive weekly snapshots required; exclusion veto and weekly pending additions reserve five slots", () => {
  const enabled = { ...p, promotion_probability: 0.8 };
  const old = snapshot("old", now - 7 * DAY), s = snapshot("current", now), d = emptyDecisions();
  assert.equal(policyReport(enabled, s, d, [s]).rows[0].two_weekly_qualifying, false);
  let r = policyReport(enabled, s, d, [old, s]);
  assert.equal(r.rows[0].two_weekly_qualifying, true); assert.deepEqual(r.ranked_ids, ["feed/a"]);
  d.intents = Array.from({ length: 5 }, (_, i) => ({ id: String(i), reason: "test", config_hash: configHash(p), original_topic_ids: [], stream_id: `feed/${i}`, action: "auto_add", at: Date.now(), week: weekKey(Date.now()), status: "pending" }));
  r = policyReport(enabled, s, d, [old, s]); assert.equal(r.weekly_slots, 0); assert.equal(r.rows[0].queued, true);
  for (const intent of d.intents) { intent.week = "earlier-week"; intent.snapshot_id = s.id; }
  r = policyReport(enabled, s, d, [old, s]); assert.equal(r.weekly_additions_reserved, 0); assert.equal(r.weekly_slots, 0);
  d.preferences["feed/a"] = { pin: true, exclude: true, history: [] };
  assert.equal(policyReport(enabled, s, d, [old, s]).rows[0].auto_add_candidate, false);
});
test("training-only snapshots never satisfy held-out calibration readiness", () => {
  const d = emptyDecisions();
  const all = Array.from({ length: 4 }, (_, i) => snapshot(`week${i}`, now + i * 7 * DAY));
  for (const s of all) for (const volume of Object.values(s.volumes)) for (const a of volume.articles) a.timestamp = now - 8 * DAY;
  // Every article was already published before its training cutoff: none is a
  // NEXT-window forecast outcome, regardless of the huge training denominator.
  const r = calibrationReport(p, all, d);
  assert.equal(r.complete_weekly_snapshots, 4); assert.equal(r.ready_for_review, false);
  assert.equal(r.feed_window_forecasts, 0); assert.equal(r.mature_holdout_articles, 0);
});
test("mature next-window outcomes, not training articles, can satisfy calibration sample gate", () => {
  const all = Array.from({ length: 4 }, (_, i) => {
    const s = snapshot(`week${i}`, now + i * 7 * DAY);
    s.subscriptions = Array.from({ length: 25 }, (_, f) => ({ id: `feed/${f}`, title: `Feed ${f}`, url: "", htmlUrl: "", categories: [{ id: "topic", label: "Topic" }] }));
    s.volumes = {}; s.prospective = {}; s.signals = {};
    for (const sub of s.subscriptions) {
      const articles = Array.from({ length: 20 }, (_, a) => article(`${sub.id}-train${a}`, now - 8 * DAY));
      for (let w = 0; w < i; w++) for (let a = 0; a < 10; a++) articles.push(article(`${sub.id}-week${w}-${a}`, now + w * 7 * DAY + DAY));
      s.volumes[sub.id] = { articles, complete: true, observed_at: s.started_at };
      s.prospective[sub.id] = { articles, first_observed: now - 100 * DAY, gap_blocked: false };
      s.signals[sub.id] = articles.filter((_, a) => a % 2 === 0);
    }
    return s;
  });
  const report = calibrationReport(p, all, emptyDecisions());
  assert.equal(report.ready_for_review, true); assert.ok(report.feed_window_forecasts >= 20); assert.ok(report.mature_holdout_articles >= 200);
  assert.ok(report.forecasts.every(f => f.n === 10));
  assert.ok(report.predictive_90_percent_coverage !== null);
  assert.equal(report.automatic_activation, false);
});
test("removal is advisory only and requires two complete snapshots, 30-day membership and no pin", () => {
  const enabled = { ...p, promotion_probability: 0.8 }, d = emptyDecisions();
  const old = snapshot("old", now - 7 * DAY, 100, 0), s = snapshot("new", now, 100, 0);
  d.membership = { at: now, ids: ["feed/a"], since: { "feed/a": now - 31 * DAY } };
  assert.equal(policyReport(enabled, s, d, [old, s]).rows[0].removal_suggestion, true);
  d.preferences["feed/a"] = { pin: true, exclude: false, history: [] };
  assert.equal(policyReport(enabled, s, d, [old, s]).rows[0].removal_suggestion, false);
});
