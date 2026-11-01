import { betaCdf } from "../statistics/beta.js";
import { fitCategoryPriors, feedPosterior, type FeedCounts, type PriorReport } from "../feed-analysis.js";
import { configHash, excludedFolders, type PriorityProfile } from "./config.js";
import { DAY, weekKey } from "./evidence.js";
import type { Decisions, PrioritySnapshot } from "./store.js";

function topicFolders(p: PriorityProfile, folders: string[]): string[] {
  const excluded = new Set(excludedFolders(p).map(folder => folder.trim().toLowerCase()));
  return folders.filter(folder => !excluded.has(folder.trim().toLowerCase()));
}
function counts(p: PriorityProfile, s: PrioritySnapshot, prospective: boolean): FeedCounts[] {
  const sourcesComplete = p.positive_streams.every(id => s.source_coverage[id] === true);
  return s.subscriptions.map(sub => {
    const volume = s.volumes[sub.id];
    const cohort = s.prospective[sub.id];
    const articles = prospective ? (cohort?.articles ?? []).filter(a => a.timestamp >= Math.max(s.cutoff, cohort!.first_observed) && a.timestamp <= s.started_at - p.maturation_days * DAY) : (volume?.articles ?? []).filter(a => a.timestamp >= s.cutoff && a.timestamp <= s.started_at);
    const ids = new Set(articles.map(a => a.id));
    const positives = (s.signals[sub.id] ?? []).filter(a => a.timestamp <= (prospective ? s.started_at - p.maturation_days * DAY : s.started_at) && a.timestamp >= (prospective ? Math.max(s.cutoff, cohort?.first_observed ?? Infinity) : s.cutoff));
    const inconsistent = positives.some(a => !ids.has(a.id));
    return { stream_id: sub.id, folders: topicFolders(p, sub.categories.map(c => c.label)), k: prospective ? positives.filter(a => ids.has(a.id)).length : positives.length, n: articles.length, volume_complete: volume?.complete === true && !inconsistent, engagement_complete: sourcesComplete && !inconsistent };
  });
}
function posterior(p: PriorityProfile, row: FeedCounts, priors: PriorReport) {
  const folders = topicFolders(p, row.folders);
  const resolved = folders.map(f => priors.by_category[f] ?? priors.global);
  const prior = resolved.length ? { alpha: resolved.reduce((n, x) => n + x.alpha, 0) / resolved.length, beta: resolved.reduce((n, x) => n + x.beta, 0) / resolved.length } : priors.global;
  const baseline = prior.alpha / (prior.alpha + prior.beta);
  const result = row.k <= row.n && row.n > 0 && (priors.global_observations ?? 0) > 0 ? feedPosterior(row.k, row.n, prior) : null;
  const benchmark = Math.max(p.absolute_benchmark_floor, p.topic_multiplier * baseline);
  return { k: row.k, n: row.n, volume_complete: row.volume_complete, engagement_complete: row.engagement_complete, retention_adjusted: row.volume_complete !== true || row.engagement_complete !== true, posterior: result, benchmark, baseline, global_fallback: !folders.length || folders.some(f => priors.fallback_categories.includes(f)), probability_above: result && benchmark < 1 ? 1 - betaCdf(benchmark, result.alpha, result.beta) : result ? 0 : null };
}
export function evaluateSnapshot(p: PriorityProfile, s: PrioritySnapshot, d: Decisions) {
  const historical = counts(p, s, false), forward = counts(p, s, true);
  const historicalPriors = fitCategoryPriors(historical, excludedFolders(p), p.prior_strength);
  const forwardPriors = fitCategoryPriors(forward, excludedFolders(p), p.prior_strength);
  const rows = s.subscriptions.map((sub, i) => {
    const h = posterior(p, historical[i], historicalPriors), f = posterior(p, forward[i], forwardPriors);
    const pref = d.preferences[sub.id];
    const reasons: string[] = [];
    if (s.phase !== "complete" || !s.completed_at) reasons.push("snapshot_incomplete");
    if (s.config_hash !== configHash(p)) reasons.push("config_mismatch");
    if (!f.volume_complete || !f.engagement_complete) reasons.push("incomplete_or_inconsistent_coverage");
    if (!s.prospective[sub.id] || s.prospective[sub.id].gap_blocked) reasons.push("prospective_observation_gap_or_missing");
    if (!(forwardPriors.global_observations! > 0)) reasons.push("no_forward_global_observations");
    if (f.n < p.minimum_observations) reasons.push("insufficient_mature_observations");
    if (f.k < p.minimum_engagements) reasons.push("insufficient_engagements");
    if (f.benchmark >= 1) reasons.push("benchmark_unreachable");
    if (pref?.exclude) reasons.push("excluded");
    const evidenceEligible = reasons.length === 0;
    if (p.promotion_probability === null) reasons.push("uncalibrated_probability");
    else if (f.probability_above === null || f.probability_above < p.promotion_probability) reasons.push("below_probability_cutoff");
    const newest = s.newest_item_timestamps?.[sub.id] ?? s.volumes[sub.id]?.articles.reduce((max, a) => Math.max(max, a.timestamp), 0) ?? 0;
    return { stream_id: sub.id, title: sub.title, folders: sub.categories.map(c => c.label), url: sub.url, html_url: sub.htmlUrl,
      member: s.membership.includes(sub.id), current_member: d.membership?.ids.includes(sub.id) ?? null,
      pinned: pref?.pin ?? false, excluded: pref?.exclude ?? false, decision: pref ?? null,
      first_observed: s.prospective[sub.id]?.first_observed ?? d.observations[sub.id]?.first_observed ?? null,
      last_complete_observation: s.volumes[sub.id]?.observed_at ?? null,
      gap_blocked: s.prospective[sub.id]?.gap_blocked ?? null,
      historical: h, prospective: f, evidence_eligible: evidenceEligible, qualifies: reasons.length === 0, reasons,
      newest_item_date: newest > 0 ? new Date(newest).toISOString() : null,
      days_since_newest: newest > 0 ? Math.max(0, (s.started_at - newest) / DAY) : null,
    };
  });
  return { rows, historical_priors: historicalPriors, prospective_priors: forwardPriors };
}
export function previousWeekly(s: PrioritySnapshot, all: PrioritySnapshot[]): PrioritySnapshot | undefined {
  return all.filter(x => x.phase === "complete" && x.completed_at && x.config_hash === s.config_hash && x.started_at < s.started_at && Date.parse(weekKey(s.started_at)) - Date.parse(weekKey(x.started_at)) === 7 * DAY && s.started_at - x.started_at >= 6 * DAY && s.started_at - x.started_at <= 10 * DAY).sort((a, b) => b.started_at - a.started_at)[0];
}
export function policyReport(p: PriorityProfile, s: PrioritySnapshot, d: Decisions, snapshots: PrioritySnapshot[]) {
  const evaluated = evaluateSnapshot(p, s, d), previous = previousWeekly(s, snapshots);
  const previousRows = previous ? evaluateSnapshot(p, previous, d).rows : [];
  const rows = evaluated.rows.map(row => {
    const old = previousRows.find(r => r.stream_id === row.stream_id);
    const twoWeekly = row.qualifies && old?.qualifies === true;
    const memberSince = d.membership?.since[row.stream_id];
    const removalEvidence = (r: typeof row) => !r.reasons.includes("config_mismatch") && !r.reasons.includes("snapshot_incomplete") && r.prospective.n >= p.minimum_observations && r.prospective.volume_complete && r.prospective.engagement_complete && r.gap_blocked === false && r.prospective.probability_above !== null && 1 - r.prospective.probability_above >= 0.8;
    return { ...row, two_weekly_qualifying: twoWeekly, auto_add_candidate: twoWeekly && !row.current_member && !row.excluded,
      removal_suggestion: !!(row.current_member && !row.pinned && memberSince !== undefined && s.started_at - memberSince >= 30 * DAY && old && removalEvidence(row) && removalEvidence(old)),
      reasons: [...row.reasons, ...(!twoWeekly ? ["requires_two_successive_complete_weekly_snapshots"] : [])],
    };
  });
  const ranked = rows.filter(r => r.auto_add_candidate).sort((a, b) => b.prospective.probability_above! - a.prospective.probability_above! || b.prospective.k - a.prospective.k || a.stream_id.localeCompare(b.stream_id));
  const spent = d.intents.filter(i => i.action === "auto_add" && i.status !== "not_applied" && i.week === weekKey(Date.now())).length;
  const snapshotSpent = d.intents.filter(i => i.action === "auto_add" && i.status !== "not_applied" && i.snapshot_id === s.id).length;
  const slots = Math.max(0, Math.min(5 - spent, 5 - snapshotSpent));
  const cutoffSweep = [0.8, 0.85, 0.9, 0.95, 0.975, 0.99].map(cutoff => ({ probability: cutoff,
    qualifying_feeds: rows.filter(r => r.evidence_eligible && r.prospective.probability_above! >= cutoff).length,
    expected_posts_per_month: rows.filter(r => r.evidence_eligible && r.prospective.probability_above! >= cutoff).reduce((sum, r) => sum + r.historical.n / p.window_months, 0),
    two_weekly_feeds: rows.filter(r => r.evidence_eligible && r.prospective.probability_above! >= cutoff && previousRows.some(old => old.stream_id === r.stream_id && old.evidence_eligible && old.prospective.probability_above! >= cutoff)).length,
  }));
  return { ...evaluated, rows: rows.map(r => ({ ...r, queued: r.auto_add_candidate && !ranked.slice(0, slots).some(x => x.stream_id === r.stream_id) })), ranked_ids: ranked.slice(0, slots).map(r => r.stream_id), weekly_additions_reserved: spent, snapshot_additions_reserved: snapshotSpent, weekly_slots: slots, cutoff_sweep: cutoffSweep };
}

/** Exact Beta-binomial predictive interval; outcomes are next-window counts,
 * never reused training observations. Computed in log space for large n. */
function predictiveInterval(n: number, alpha: number, beta: number): [number, number] {
  let logp = 0;
  for (let j = 0; j < n; j++) logp += Math.log(beta + j) - Math.log(alpha + beta + j);
  const logs = [logp];
  for (let k = 0; k < n; k++) { logp += Math.log(n - k) - Math.log(k + 1) + Math.log(alpha + k) - Math.log(beta + n - k - 1); logs.push(logp); }
  const max = logs.reduce((a, b) => Math.max(a, b), -Infinity), weights = logs.map(x => Math.exp(x - max)), total = weights.reduce((a, b) => a + b, 0);
  let sum = 0, low = 0, high = n, found = false;
  for (let k = 0; k <= n; k++) { sum += weights[k] / total; if (!found && sum >= 0.05) { low = k; found = true; } if (sum >= 0.95) { high = k; break; } }
  return [low, high];
}
export function calibrationReport(p: PriorityProfile, snapshots: PrioritySnapshot[], d: Decisions) {
  const complete = snapshots.filter(s => s.phase === "complete" && s.completed_at && s.config_hash === configHash(p)).sort((a, b) => a.started_at - b.started_at);
  const weekly = new Map<string, PrioritySnapshot>(); for (const s of complete) weekly.set(weekKey(s.started_at), s);
  const forecasts: { stream_id: string; training_snapshot: string; holdout_snapshot: string; n: number; k: number; expected_k: number; predictive_interval: [number, number]; covered: boolean; folders: string[] }[] = [];
  const heldOutIds = new Set<string>();
  for (const train of weekly.values()) {
    // Forecast the NEXT seven-day window, evaluate only after its last article
    // has had the full maturation period. Immediate next-week training is not
    // a mature holdout and cannot count toward readiness.
    const test = [...weekly.values()].filter(s => s.started_at >= train.completed_at! + (7 + p.maturation_days) * DAY).sort((a, b) => a.started_at - b.started_at)[0];
    if (!test || test.started_at - train.completed_at! > (17 + p.maturation_days) * DAY) continue;
    const training = evaluateSnapshot(p, train, d).rows;
    const testing = new Map(evaluateSnapshot(p, test, d).rows.map(row => [row.stream_id, row]));
    for (const row of training) {
      if (!row.prospective.posterior || !row.prospective.engagement_complete || !row.prospective.volume_complete || row.gap_blocked !== false) continue;
      const testRow = testing.get(row.stream_id);
      if (!testRow?.prospective.engagement_complete || !testRow.prospective.volume_complete) continue;
      const cohort = test.prospective[row.stream_id];
      if (!cohort || cohort.gap_blocked || !test.volumes[row.stream_id]?.complete || !p.positive_streams.every(id => test.source_coverage[id])) continue;
      const oldIds = new Set(train.prospective[row.stream_id]?.articles.map(a => a.id));
      const holdout = cohort.articles.filter(a => !heldOutIds.has(`${row.stream_id}\u0000${a.id}`) && !oldIds.has(a.id) && a.timestamp > train.completed_at! && a.timestamp <= train.completed_at! + 7 * DAY && a.timestamp <= test.started_at - p.maturation_days * DAY);
      if (!holdout.length) continue;
      for (const a of holdout) heldOutIds.add(`${row.stream_id}\u0000${a.id}`);
      const positive = new Set(test.signals[row.stream_id]?.map(a => a.id));
      const n = holdout.length, k = holdout.filter(a => positive.has(a.id)).length;
      const post = row.prospective.posterior, interval = predictiveInterval(n, post.alpha, post.beta);
      forecasts.push({ stream_id: row.stream_id, training_snapshot: train.id, holdout_snapshot: test.id, n, k, expected_k: n * post.mean, predictive_interval: interval, covered: k >= interval[0] && k <= interval[1], folders: topicFolders(p, row.folders) });
    }
  }
  const mature = forecasts.reduce((n, f) => n + f.n, 0);
  const categories = [...new Set(forecasts.flatMap(f => f.folders))];
  return { ready_for_review: weekly.size >= 4 && forecasts.length >= 20 && mature >= 200, automatic_activation: false,
    complete_weekly_snapshots: weekly.size, feed_window_forecasts: forecasts.length, mature_holdout_articles: mature,
    requirements: { complete_weekly_snapshots: 4, feed_window_forecasts: 20, mature_holdout_articles: 200 },
    predictive_90_percent_coverage: forecasts.length ? forecasts.filter(f => f.covered).length / forecasts.length : null,
    mean_absolute_holdout_rate_error: forecasts.length ? forecasts.reduce((sum, f) => sum + Math.abs(f.k - f.expected_k) / f.n, 0) / forecasts.length : null,
    by_category: Object.fromEntries(categories.map(c => { const fs = forecasts.filter(f => f.folders.includes(c)); return [c, { forecasts: fs.length, mature_articles: fs.reduce((n, f) => n + f.n, 0), covered: fs.filter(f => f.covered).length }]; })),
    forecasts, warning: "Readiness is a held-out sample-size gate, not proof of calibration. Review coverage, stability and uncertainty before explicitly enabling. Training data never counts as holdout." };
}
