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
test("positive label dates never select the canonical exposure window or maturity", () => {
  const s = snapshot("canonical", now), d = emptyDecisions();
  const canonical = [article("long-normalized", now - 7 * DAY), article("recent", now - 6 * DAY), article("too-old", s.cutoff - DAY), article("pre-observation", now - 101 * DAY)];
  s.volumes["feed/a"].articles = canonical;
  s.prospective["feed/a"].articles = canonical;
  // Simulate saves from different streams/times; all dates are irrelevant here.
  s.signals["feed/a"] = canonical.map((a, i) => ({ ...a, timestamp: i % 2 ? now : s.cutoff - 30 * DAY }));
  const row = evaluateSnapshot(p, s, d).rows[0];
  assert.equal(row.historical.n, 3); assert.equal(row.historical.k, 3);
  assert.equal(row.prospective.n, 1); assert.equal(row.prospective.k, 1);
  assert.equal(row.prospective.engagement_complete, true);
  assert.equal(row.prospective.volume_complete, true);
  // Known feed exposure predating observation may be absent from the forward ledger.
  s.prospective["feed/a"].articles = canonical.slice(0, 2);
  assert.equal(evaluateSnapshot(p, s, d).rows[0].prospective.engagement_complete, true);
  s.signals["feed/a"].push(article("unknown-exposure", s.cutoff - DAY));
  const unknown = evaluateSnapshot(p, s, d).rows[0];
  assert.equal(unknown.prospective.engagement_complete, false);
  assert.equal(unknown.historical.engagement_complete, false);
  assert.equal(unknown.evidence_eligible, false);
});
test("one fresh complete mature-historical snapshot qualifies provisionally without forward history", () => {
  const at = Date.now(), s = snapshot("provisional", at), d = emptyDecisions();
  const profile = { ...p, promotion_mode: "provisional" as const, promotion_probability: 0.95 };
  s.prospective = {};
  // Raw historical context includes recent posts; promotion must not include them.
  const recent = Array.from({ length: 30 }, (_, i) => article(`recent-${i}`, at - DAY));
  s.volumes["feed/a"].articles.push(...recent);
  s.signals["feed/a"] = s.signals["feed/a"].map(a => ({ ...a, timestamp: at }));
  s.signals["feed/a"].push(...recent);
  let r = policyReport(profile, s, d, [s]), row = r.rows[0];
  assert.equal(row.historical.n, 80); assert.equal(row.historical.k, 70);
  assert.equal(row.prospective.n, 0);
  assert.equal(row.promotion_evidence.basis, "mature_historical");
  assert.equal(row.promotion_evidence.n, 50); assert.equal(row.promotion_evidence.k, 40);
  assert.equal(row.promotion_evidence.benchmark, 0.2);
  assert.ok(row.promotion_evidence.probability_above! >= 0.95);
  assert.equal(row.auto_add_candidate, true); assert.equal(row.two_weekly_qualifying, false);
  assert.deepEqual(r.ranked_ids, ["feed/a"]);
  assert.ok(!row.reasons.includes("requires_two_successive_complete_weekly_snapshots"));
  assert.equal(calibrationReport(profile, [s], d).ready_for_review, false);
  assert.equal(r.cutoff_sweep.find(c => c.probability === 0.95)?.qualifying_feeds, 1);
  assert.ok(r.cutoff_sweep.every(c => c.basis === "mature_historical"));
  assert.equal(r.promotion_priors.global_observations, 1050);
  assert.equal(r.historical_priors.global_observations, 1080);
  const calibrated = policyReport({ ...profile, promotion_mode: "calibrated" }, s, d, [s]);
  assert.deepEqual(calibrated.ranked_ids, []);
  assert.equal(calibrated.rows[0].promotion_evidence.basis, "prospective");
  for (const mutate of [
    (x: PrioritySnapshot) => { x.phase = "volumes"; x.completed_at = null; },
    (x: PrioritySnapshot) => { x.started_at -= 8 * DAY; },
    (x: PrioritySnapshot) => { x.source_coverage[p.positive_streams[0]] = false; },
    (x: PrioritySnapshot) => { x.signals["feed/a"].push(article("missing-canonical", at)); },
    (x: PrioritySnapshot) => { x.volumes["feed/a"].articles = x.volumes["feed/a"].articles.slice(0, 19); x.signals["feed/a"] = x.volumes["feed/a"].articles; },
    (x: PrioritySnapshot) => { x.signals["feed/a"] = x.signals["feed/a"].slice(0, 4); },
  ]) {
    const copy = structuredClone(s); mutate(copy);
    assert.equal(policyReport(profile, copy, d, [copy]).rows[0].auto_add_candidate, false);
  }
  d.preferences["feed/a"] = { pin: false, exclude: true, history: [] };
  assert.deepEqual(policyReport(profile, s, d, [s]).ranked_ids, []);
});
test("provisional rank, sweep, queue and both five-addition caps use mature historical evidence", () => {
  const at = Date.now(), s = snapshot("rank-history", at), d = emptyDecisions();
  const profile = { ...p, promotion_mode: "provisional" as const, promotion_probability: 0.95 };
  // Six qualifying feeds and a large low-rate topic baseline. Deliberately empty
  // forward evidence would rank nothing if any report path used legacy stats.
  const template = s.subscriptions[0];
  for (let i = 0; i < 6; i++) {
    const id = `feed/c${i}`, articles = Array.from({ length: 50 }, (_, j) => article(`${id}-${j}`, at - 8 * DAY));
    s.subscriptions.push({ ...template, id });
    s.volumes[id] = { articles, complete: true, observed_at: at };
    s.signals[id] = articles.slice(0, 35 + i);
  }
  const baseline = s.volumes["feed/b"].articles;
  for (let i = 0; i < 9000; i++) baseline.push(article(`base-extra-${i}`, at - 8 * DAY));
  s.prospective = {};
  let r = policyReport(profile, s, d, [s]);
  assert.equal(r.ranked_ids.length, 5);
  assert.equal(r.rows.filter(row => row.queued).length, 2);
  assert.ok(r.rows.filter(row => row.auto_add_candidate).every(row => row.promotion_evidence.probability_above! >= 0.95));
  const ranked = r.rows.filter(row => row.auto_add_candidate).sort((a, b) => b.promotion_evidence.probability_above! - a.promotion_evidence.probability_above! || b.promotion_evidence.k - a.promotion_evidence.k || a.stream_id.localeCompare(b.stream_id));
  assert.deepEqual(r.ranked_ids, ranked.slice(0, 5).map(row => row.stream_id));
  assert.equal(r.cutoff_sweep.find(c => c.probability === 0.95)?.qualifying_feeds, 7);
  d.intents = Array.from({ length: 5 }, (_, i) => ({ id: String(i), reason: "reserved", config_hash: configHash(p), original_topic_ids: [], stream_id: `feed/reserved-${i}`, action: "auto_add", at, week: weekKey(Date.now()), status: "unverified" }));
  r = policyReport(profile, s, d, [s]);
  assert.equal(r.weekly_slots, 0); assert.deepEqual(r.ranked_ids, []);
  for (const intent of d.intents) { intent.week = "previous-week"; intent.snapshot_id = s.id; }
  r = policyReport(profile, s, d, [s]);
  assert.equal(r.weekly_additions_reserved, 0); assert.equal(r.snapshot_additions_reserved, 5); assert.deepEqual(r.ranked_ids, []);
  for (const intent of d.intents) intent.status = "not_applied";
  assert.equal(policyReport(profile, s, d, [s]).ranked_ids.length, 5);
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
