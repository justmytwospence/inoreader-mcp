import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { apiGet, invalidateCache } from "../api.js";
import type {
  ArticleItem,
  StreamContentsResponse,
} from "../types.js";

// ---------------------------------------------------------------------------
// Math helpers (no external deps; mirrors inline-math convention from analytics.ts)
// ---------------------------------------------------------------------------

// Lanczos approximation (g=5, n=6) to log(Gamma(x)) for x > 0
function lgamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5;
  const s = (x + 0.5) * Math.log(tmp) - tmp;
  let ser = 1.000000000190015;
  for (const c of cof) {
    y += 1;
    ser += c / y;
  }
  return s + Math.log((2.5066282746310005 * ser) / x);
}

// Continued fraction expansion for I_x(a, b). Lentz's method.
function betaCf(x: number, a: number, b: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta function I_x(a, b) = Beta CDF
function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt =
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCf(x, a, b)) / a;
  }
  return 1 - (bt * betaCf(1 - x, b, a)) / b;
}

// Inverse Beta CDF via bisection (60 iters → ~1e-18 precision)
function betaQuantile(q: number, a: number, b: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Marsaglia-Tsang gamma sampler (shape >= 1; recursive boost for shape < 1)
function sampleStdNormal(): number {
  // Box-Muller, returns one draw (we discard the second for simplicity)
  const u1 = Math.max(Math.random(), 1e-300);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    const g = sampleGamma(shape + 1);
    return g * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = sampleStdNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(a: number, b: number): number {
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  return x / (x + y);
}

// Pool-adjacent-violators on (mean, weight) sequence. Returns smoothed mean per index.
function pav(points: Array<{ mean: number; weight: number }>): number[] {
  if (points.length === 0) return [];
  const pools: Array<{ sum: number; weight: number; indices: number[] }> = points.map(
    (p, i) => ({
      sum: p.mean * p.weight,
      weight: p.weight,
      indices: [i],
    }),
  );
  let i = 0;
  while (i < pools.length - 1) {
    const cur = pools[i];
    const next = pools[i + 1];
    const curMean = cur.weight > 0 ? cur.sum / cur.weight : 0;
    const nextMean = next.weight > 0 ? next.sum / next.weight : 0;
    if (curMean > nextMean) {
      cur.sum += next.sum;
      cur.weight += next.weight;
      cur.indices.push(...next.indices);
      pools.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  const result: number[] = new Array(points.length).fill(0);
  for (const pool of pools) {
    const m = pool.weight > 0 ? pool.sum / pool.weight : 0;
    for (const idx of pool.indices) result[idx] = m;
  }
  return result;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const VERIFIED_TAGS = [
  { id: "user/-/label/read/worth-it", stratum: "recommended", label: "worth-it" },
  { id: "user/-/label/read/not-worth-it", stratum: "recommended", label: "not-worth-it" },
  { id: "user/-/label/audit/worth-it", stratum: "audit", label: "worth-it" },
  { id: "user/-/label/audit/not-worth-it", stratum: "audit", label: "not-worth-it" },
] as const;

const VERIFIED_TAG_IDS = new Set<string>(VERIFIED_TAGS.map((t) => t.id));

function htmlStrip(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedClassifier {
  decision: "read" | "skip";
  score: number;
}

function parseClassifierOutput(text: string): ParsedClassifier | null {
  const recMatch = text.match(/RECOMMENDATION\s*:\s*(read|skip)\b/i);
  const confMatch = text.match(/CONFIDENCE\s*:\s*(\d{1,3})\b/);
  if (!recMatch || !confMatch) return null;
  const score = parseInt(confMatch[1], 10);
  if (Number.isNaN(score) || score < 0 || score > 100) return null;
  return {
    decision: recMatch[1].toLowerCase() as "read" | "skip",
    score,
  };
}

function parseArticleSummaries(
  item: ArticleItem,
  preferredPromptName?: string,
): {
  result: ParsedClassifier | null;
  status: "ok" | "unparseable" | "missing_summary";
  summaryText: string;
} {
  if (!item.summaries || item.summaries.length === 0) {
    return { result: null, status: "missing_summary", summaryText: "" };
  }
  const filtered = preferredPromptName
    ? item.summaries.filter((s) => s.prompt_name === preferredPromptName)
    : [];
  const candidates = filtered.length > 0 ? filtered : item.summaries;
  for (const s of candidates) {
    const text = htmlStrip(s.summary);
    const parsed = parseClassifierOutput(text);
    if (parsed) {
      return { result: parsed, status: "ok", summaryText: text.slice(0, 300) };
    }
  }
  return {
    result: null,
    status: "unparseable",
    summaryText: htmlStrip(candidates[0].summary).slice(0, 300),
  };
}

function extractFolders(categories: string[]): string[] {
  const labelPrefix = "user/-/label/";
  const folders: string[] = [];
  for (const c of categories) {
    if (VERIFIED_TAG_IDS.has(c)) continue;
    if (c.startsWith(labelPrefix)) {
      folders.push(c.slice(labelPrefix.length));
    }
  }
  return folders;
}

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

interface VerifiedRow {
  id: string;
  feed_id: string | null;
  feed_title: string | null;
  folders: string[];
  published: number;
  title: string;
  summary_text: string;
  decision: "read" | "skip" | null;
  score: number | null;
  label: "worth-it" | "not-worth-it";
  stratum: "recommended" | "audit";
  parse_status: "ok" | "unparseable" | "missing_summary";
}

interface PopulationRow {
  id: string;
  feed_id: string | null;
  feed_title: string | null;
  folders: string[];
  published: number;
  title: string;
  summary_text: string;
  decision: "read" | "skip" | null;
  score: number | null;
  parse_status: "ok" | "unparseable" | "missing_summary";
}

interface ExtractArgs {
  prompt_name?: string;
  include_population?: boolean;
  population_folder?: string;
  population_months?: number;
  population_pages?: number;
  refresh?: boolean;
}

interface ExtractResult {
  verified: VerifiedRow[];
  population: PopulationRow[];
  summary: {
    verified_count: number;
    audit_count: number;
    parseable: number;
    unparseable: number;
    missing_summary: number;
    decision_distribution: { read: number; skip: number; null: number };
    tag_decision_mismatches: number;
    population_count: number;
    population_pages_used: number;
    population_hit_cap: boolean;
    api_cost_z1: number;
    window_months: number | null;
  };
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

const VERIFIED_TAG_PAGE_CAP = 20;

async function paginateStream(
  streamId: string,
  options: { since?: string; maxPages: number; pageSize?: number },
): Promise<{ items: ArticleItem[]; pagesUsed: number; hitCap: boolean }> {
  const items: ArticleItem[] = [];
  let continuation: string | undefined;
  let pages = 0;
  while (pages < options.maxPages) {
    const queryParams: Record<string, string> = {
      output: "json",
      n: String(options.pageSize ?? 100),
      summaries: "1",
    };
    if (options.since) queryParams.ot = options.since;
    if (continuation) queryParams.c = continuation;
    let data: StreamContentsResponse;
    try {
      data = await apiGet<StreamContentsResponse>(
        `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}`,
        queryParams,
      );
    } catch {
      break;
    }
    pages++;
    items.push(...data.items);
    if (!data.continuation) break;
    continuation = data.continuation;
  }
  return { items, pagesUsed: pages, hitCap: pages >= options.maxPages };
}

// ---------------------------------------------------------------------------
// extract_classifier_data — shared implementation
// ---------------------------------------------------------------------------

async function extractClassifierData(args: ExtractArgs): Promise<ExtractResult> {
  if (args.refresh) invalidateCache();

  const verified: VerifiedRow[] = [];
  const verifiedIds = new Set<string>();
  let z1Cost = 0;
  let parseable = 0;
  let unparseable = 0;
  let missing = 0;
  let mismatches = 0;
  const decisionCounts = { read: 0, skip: 0, null: 0 };
  let auditCount = 0;

  for (const tag of VERIFIED_TAGS) {
    const { items, pagesUsed } = await paginateStream(tag.id, {
      maxPages: VERIFIED_TAG_PAGE_CAP,
    });
    z1Cost += pagesUsed;
    for (const item of items) {
      if (verifiedIds.has(item.id)) continue;
      verifiedIds.add(item.id);
      const parsed = parseArticleSummaries(item, args.prompt_name);
      if (parsed.status === "ok") parseable++;
      else if (parsed.status === "unparseable") unparseable++;
      else missing++;
      const decision = parsed.result?.decision ?? null;
      if (decision === "read") decisionCounts.read++;
      else if (decision === "skip") decisionCounts.skip++;
      else decisionCounts.null++;

      // Tag-decision sanity check
      if (
        parsed.result &&
        ((tag.stratum === "recommended" && parsed.result.decision !== "read") ||
          (tag.stratum === "audit" && parsed.result.decision !== "skip"))
      ) {
        mismatches++;
      }
      if (tag.stratum === "audit") auditCount++;

      verified.push({
        id: item.id,
        feed_id: item.origin?.streamId ?? null,
        feed_title: item.origin?.title ?? null,
        folders: extractFolders(item.categories),
        published: item.published,
        title: item.title,
        summary_text: parsed.summaryText,
        decision,
        score: parsed.result?.score ?? null,
        label: tag.label,
        stratum: tag.stratum,
        parse_status: parsed.status,
      });
    }
  }

  const population: PopulationRow[] = [];
  let popPagesUsed = 0;
  let popHitCap = false;
  let windowMonths: number | null = null;

  if (args.include_population) {
    const months = args.population_months ?? 3;
    windowMonths = months;
    const sinceSec = Math.floor(
      (Date.now() - months * 30 * 24 * 60 * 60 * 1000) / 1000,
    );
    const popStreamId = args.population_folder
      ? `user/-/label/${args.population_folder}`
      : "user/-/state/com.google/reading-list";
    const popPagesCap = args.population_pages ?? 30;

    const { items, pagesUsed, hitCap } = await paginateStream(popStreamId, {
      since: String(sinceSec),
      maxPages: popPagesCap,
    });
    z1Cost += pagesUsed;
    popPagesUsed = pagesUsed;
    popHitCap = hitCap;

    for (const item of items) {
      if (verifiedIds.has(item.id)) continue;
      const parsed = parseArticleSummaries(item, args.prompt_name);
      population.push({
        id: item.id,
        feed_id: item.origin?.streamId ?? null,
        feed_title: item.origin?.title ?? null,
        folders: extractFolders(item.categories),
        published: item.published,
        title: item.title,
        summary_text: parsed.summaryText,
        decision: parsed.result?.decision ?? null,
        score: parsed.result?.score ?? null,
        parse_status: parsed.status,
      });
    }
  }

  return {
    verified,
    population,
    summary: {
      verified_count: verified.length,
      audit_count: auditCount,
      parseable,
      unparseable,
      missing_summary: missing,
      decision_distribution: decisionCounts,
      tag_decision_mismatches: mismatches,
      population_count: population.length,
      population_pages_used: popPagesUsed,
      population_hit_cap: popHitCap,
      api_cost_z1: z1Cost,
      window_months: windowMonths,
    },
  };
}

// ---------------------------------------------------------------------------
// analyze_classifier_calibration — shared implementation
// ---------------------------------------------------------------------------

interface AnalyzeArgs extends ExtractArgs {
  bins?: number;
  prior_strength?: number;
  breakdown_by?: Array<"feed" | "folder">;
  min_bin_n?: number;
  decision_threshold?: number;
}

interface BinRow {
  bin_low: number;
  bin_high: number;
  bin_center: number;
  n: number;
  k: number;
  posterior_mean: number;
  ci_low: number;
  ci_high: number;
  contains_diagonal: boolean;
  smoothed_mean: number;
  low_data: boolean;
}

interface CalibrationResult {
  bins: BinRow[];
  monotonicity_violations: Array<{
    bin_a: number;
    bin_b: number;
    mean_a: number;
    mean_b: number;
  }>;
  ece: number;
  total_n: number;
  prior: { alpha: number; beta: number; rate: number; strength: number };
}

function computeCalibration(
  rows: VerifiedRow[],
  binCount: number,
  priorStrength: number,
  minBinN: number,
): CalibrationResult {
  // Restrict to verified-recommended rows that parsed cleanly with decision=read
  const eligible = rows.filter(
    (r) =>
      r.stratum === "recommended" &&
      r.parse_status === "ok" &&
      r.score !== null &&
      r.decision === "read",
  );

  // Empirical-Bayes prior from the marginal worth-it rate on this slice
  const k_total = eligible.filter((r) => r.label === "worth-it").length;
  const n_total = eligible.length;
  const rate = n_total > 0 ? k_total / n_total : 0.5;
  const alpha0 = rate * priorStrength;
  const beta0 = (1 - rate) * priorStrength;

  const binWidth = 100 / binCount;
  const binAgg: Array<{ k: number; n: number }> = Array.from({ length: binCount }, () => ({
    k: 0,
    n: 0,
  }));
  for (const r of eligible) {
    if (r.score === null) continue;
    const idx = Math.min(Math.floor(r.score / binWidth), binCount - 1);
    binAgg[idx].n++;
    if (r.label === "worth-it") binAgg[idx].k++;
  }

  // Per-bin Beta posterior mean for PAV input (weighted by n)
  const pavInput = binAgg.map((b) => {
    const a = alpha0 + b.k;
    const bt = beta0 + (b.n - b.k);
    const mean = a / (a + bt);
    return { mean, weight: b.n + priorStrength };
  });
  const smoothed = pav(pavInput);

  // Build per-bin output rows
  const bins: BinRow[] = binAgg.map((b, i) => {
    const a = alpha0 + b.k;
    const bt = beta0 + (b.n - b.k);
    const mean = a / (a + bt);
    const ciLow = betaQuantile(0.025, a, bt);
    const ciHigh = betaQuantile(0.975, a, bt);
    const binLow = i * binWidth;
    const binHigh = i === binCount - 1 ? 100 : (i + 1) * binWidth;
    const center = (binLow + binHigh) / 2;
    const diag = center / 100;
    return {
      bin_low: binLow,
      bin_high: binHigh,
      bin_center: center,
      n: b.n,
      k: b.k,
      posterior_mean: round4(mean),
      ci_low: round4(ciLow),
      ci_high: round4(ciHigh),
      contains_diagonal: ciLow <= diag && diag <= ciHigh,
      smoothed_mean: round4(smoothed[i]),
      low_data: b.n < minBinN,
    };
  });

  // Monotonicity violations on raw posterior means
  const violations: CalibrationResult["monotonicity_violations"] = [];
  for (let i = 0; i < bins.length - 1; i++) {
    if (bins[i].posterior_mean > bins[i + 1].posterior_mean) {
      violations.push({
        bin_a: i,
        bin_b: i + 1,
        mean_a: bins[i].posterior_mean,
        mean_b: bins[i + 1].posterior_mean,
      });
    }
  }

  // ECE: weighted average |posterior_mean - bin_center/100|
  let ece = 0;
  let totalWeight = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    ece += b.n * Math.abs(b.posterior_mean - b.bin_center / 100);
    totalWeight += b.n;
  }
  ece = totalWeight > 0 ? ece / totalWeight : 0;

  return {
    bins,
    monotonicity_violations: violations,
    ece: round4(ece),
    total_n: n_total,
    prior: {
      alpha: round4(alpha0),
      beta: round4(beta0),
      rate: round4(rate),
      strength: priorStrength,
    },
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function thresholdDiagnostic(
  bins: BinRow[],
  threshold: number,
): {
  threshold: number;
  containing_bin_index: number;
  containing_bin: BinRow | null;
  lowest_recommend_bin_index: number;
  lowest_recommend_bin: BinRow | null;
  interpretation: string;
} {
  const idx = Math.min(
    Math.max(0, Math.floor((threshold / 100) * bins.length)),
    bins.length - 1,
  );
  const containing = bins[idx] ?? null;

  let lowestIdx = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].n > 0) {
      lowestIdx = i;
      break;
    }
  }
  const lowest = lowestIdx >= 0 ? bins[lowestIdx] : null;

  let interp: string;
  if (lowest && lowest.n > 0) {
    interp =
      `Among recommend-read articles in the lowest-score bin with data ` +
      `[${lowest.bin_low}-${lowest.bin_high}), worth-it rate is ${lowest.posterior_mean.toFixed(3)} ` +
      `(95% CI [${lowest.ci_low.toFixed(3)}, ${lowest.ci_high.toFixed(3)}], n=${lowest.n}). ` +
      `By monotonicity, articles below this score should have worth-it rate at most this value.`;
  } else {
    interp = "No verified-recommended data available.";
  }

  return {
    threshold,
    containing_bin_index: idx,
    containing_bin: containing,
    lowest_recommend_bin_index: lowestIdx,
    lowest_recommend_bin: lowest,
    interpretation: interp,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCalibrationTools(server: McpServer): void {
  server.tool(
    "extract_classifier_data",
    "Pull Inoreader Intelligence summaries for the four verification-tagged streams (read/worth-it, read/not-worth-it, audit/worth-it, audit/not-worth-it) and parse a binary RECOMMENDATION + CONFIDENCE classifier output from each. Optionally also scans a folder/window for the score distribution among unverified articles. The verified set is the labeled dataset for calibration analysis. The population scan is the candidate pool for audit recommendations. Caches per Inoreader URL; pass refresh=true to force re-fetch. Costs ~4-8 Zone 1 requests for the verified set (4 tag streams paginated up to 20 pages each, but typically 1-2 pages each), plus up to population_pages Zone 1 if include_population is true.",
    {
      prompt_name: z
        .string()
        .optional()
        .describe(
          "Inoreader Intelligence prompt_name to filter summaries by. If omitted, the parser scans all summaries on each article and uses the first that matches the RECOMMENDATION/CONFIDENCE format.",
        ),
      include_population: z
        .boolean()
        .optional()
        .describe(
          "Also fetch a window of articles (with summaries=1) to characterize the population score distribution. Default false. Required for recommend_audit_articles downstream.",
        ),
      population_folder: z
        .string()
        .optional()
        .describe(
          "Folder name to limit the population scan to. If omitted, scans the full reading-list stream.",
        ),
      population_months: z
        .number()
        .min(1)
        .max(24)
        .optional()
        .describe("Window in months for the population scan (default 3)."),
      population_pages: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Per-stream page cap for the population scan (default 30)."),
      refresh: z
        .boolean()
        .optional()
        .describe("Clear the cache before fetching (default false)."),
    },
    async (params) => {
      const result = await extractClassifierData(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "analyze_classifier_calibration",
    "Build a reliability diagram for the LLM classifier on the verified-recommended slice. Bins articles by CONFIDENCE score, computes per-bin Beta-Binomial posteriors with an empirical-Bayes prior from the marginal worth-it rate, and reports posterior mean + 95% credible interval per bin. Pool-adjacent-violators (isotonic regression, weighted by bin n) gives a monotone-smoothed curve for visualization; per-bin intervals are the source of truth for inference. Reports ECE, monotonicity violations, a threshold diagnostic (lowest-score recommend-read bin gives an upper bound on what's just below threshold by monotonicity), Manski-style FNR bounds (always identifiable), and an audit-conditional recall posterior via Monte Carlo when audit data exists. Optional per-feed and per-folder slices for multicalibration-lite. Calls extract_classifier_data internally; cost is the same as that call.",
    {
      prompt_name: z.string().optional().describe("Forwarded to extract_classifier_data."),
      include_population: z
        .boolean()
        .optional()
        .describe("Forwarded to extract_classifier_data."),
      population_folder: z
        .string()
        .optional()
        .describe("Forwarded to extract_classifier_data."),
      population_months: z
        .number()
        .min(1)
        .max(24)
        .optional()
        .describe("Forwarded to extract_classifier_data."),
      population_pages: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Forwarded to extract_classifier_data."),
      refresh: z.boolean().optional().describe("Forwarded to extract_classifier_data."),
      bins: z
        .number()
        .min(2)
        .max(50)
        .optional()
        .describe("Number of equal-width score bins on 0-100 (default 10)."),
      prior_strength: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Beta prior pseudo-observation count, allocated empirically from the marginal worth-it rate (default 4). Higher values shrink small-bin posteriors more aggressively toward the global mean.",
        ),
      breakdown_by: z
        .array(z.enum(["feed", "folder"]))
        .optional()
        .describe(
          "Additional slices to compute calibration on. Each slice with total n < min_bin_n is reported but flagged.",
        ),
      min_bin_n: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Bins below this n are reported as low-data (default 3)."),
      decision_threshold: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Score threshold for the diagnostic (default 50). Actual decisions are read from parsed RECOMMENDATION; this is only used to locate the diagnostic bin.",
        ),
    },
    async (params) => {
      const data = await extractClassifierData(params);
      const binCount = params.bins ?? 10;
      const priorStrength = params.prior_strength ?? 4;
      const minBinN = params.min_bin_n ?? 3;
      const threshold = params.decision_threshold ?? 50;

      const overall = computeCalibration(
        data.verified,
        binCount,
        priorStrength,
        minBinN,
      );
      const diag = thresholdDiagnostic(overall.bins, threshold);

      // Precision: posterior on full verified-recommended slice
      const recommended = data.verified.filter(
        (r) => r.stratum === "recommended" && r.parse_status === "ok",
      );
      const recK = recommended.filter((r) => r.label === "worth-it").length;
      const recN = recommended.length;
      const precPriorAlpha = overall.prior.alpha;
      const precPriorBeta = overall.prior.beta;
      const precA = precPriorAlpha + recK;
      const precB = precPriorBeta + (recN - recK);
      const precision = {
        n: recN,
        k: recK,
        posterior_mean: round4(precA / (precA + precB)),
        ci_low: round4(betaQuantile(0.025, precA, precB)),
        ci_high: round4(betaQuantile(0.975, precA, precB)),
      };

      // Manski recall bounds. Recall = TP / (TP + FN). TP = recK is observed.
      // FN ranges from 0 (no skipped article was worth-it) to popSkip (all were).
      // Only meaningful when include_population=true.
      const popSkip = data.population.filter(
        (r) => r.parse_status === "ok" && r.decision === "skip",
      ).length;
      const popRead = data.population.filter(
        (r) => r.parse_status === "ok" && r.decision === "read",
      ).length;
      const recallBounds = popSkip > 0 && recK > 0
        ? {
            recall_low: round4(recK / (recK + popSkip)),
            recall_high: 1,
            n_skip_observed: popSkip,
            n_read_observed: popRead,
            n_recommended_worth_it: recK,
            interpretation:
              `Manski bounds: recall is at least ${(recK / (recK + popSkip)).toFixed(3)} ` +
              `(if every recommend-skip article in the population scan were worth-it) and at most 1.0 ` +
              `(if none were). Audit data tightens these via the recall_posterior below.`,
          }
        : null;

      // Audit-conditional recall posterior (Monte Carlo)
      const auditRows = data.verified.filter(
        (r) => r.stratum === "audit" && r.parse_status === "ok",
      );
      let recallPosterior: {
        mean: number;
        ci_low: number;
        ci_high: number;
        audit_n: number;
        audit_k: number;
      } | null = null;

      if (auditRows.length > 0 && popSkip > 0 && popRead > 0) {
        const auditK = auditRows.filter((r) => r.label === "worth-it").length;
        const auditN = auditRows.length;
        // Posterior on P(worth-it | D=skip)
        const aSkip = overall.prior.alpha + auditK;
        const bSkip = overall.prior.beta + (auditN - auditK);
        // Posterior on P(worth-it | D=read) = precision
        const aRead = precA;
        const bRead = precB;
        const draws = 10000;
        const recallDraws: number[] = [];
        for (let i = 0; i < draws; i++) {
          const pRead = sampleBeta(aRead, bRead);
          const pSkip = sampleBeta(aSkip, bSkip);
          // recall = TP / (TP + FN) = (pRead * n_read) / (pRead * n_read + pSkip * n_skip)
          const tp = pRead * popRead;
          const fn = pSkip * popSkip;
          const r = tp + fn > 0 ? tp / (tp + fn) : 0;
          recallDraws.push(r);
        }
        recallDraws.sort((a, b) => a - b);
        const meanR = recallDraws.reduce((s, x) => s + x, 0) / draws;
        recallPosterior = {
          mean: round4(meanR),
          ci_low: round4(quantile(recallDraws, 0.025)),
          ci_high: round4(quantile(recallDraws, 0.975)),
          audit_n: auditN,
          audit_k: auditK,
        };
      }

      // Per-feed / per-folder breakdowns
      const breakdowns: Record<string, Record<string, CalibrationResult>> = {};
      const breakdownBy = params.breakdown_by ?? [];
      if (breakdownBy.includes("feed")) {
        const byFeed = new Map<string, VerifiedRow[]>();
        for (const r of data.verified) {
          const key = r.feed_title ?? r.feed_id ?? "(unknown)";
          if (!byFeed.has(key)) byFeed.set(key, []);
          byFeed.get(key)!.push(r);
        }
        breakdowns.by_feed = {};
        for (const [key, rows] of byFeed) {
          breakdowns.by_feed[key] = computeCalibration(
            rows,
            binCount,
            priorStrength,
            minBinN,
          );
        }
      }
      if (breakdownBy.includes("folder")) {
        const byFolder = new Map<string, VerifiedRow[]>();
        for (const r of data.verified) {
          if (r.folders.length === 0) {
            if (!byFolder.has("(no folder)")) byFolder.set("(no folder)", []);
            byFolder.get("(no folder)")!.push(r);
          }
          for (const f of r.folders) {
            if (!byFolder.has(f)) byFolder.set(f, []);
            byFolder.get(f)!.push(r);
          }
        }
        breakdowns.by_folder = {};
        for (const [key, rows] of byFolder) {
          breakdowns.by_folder[key] = computeCalibration(
            rows,
            binCount,
            priorStrength,
            minBinN,
          );
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                calibration: {
                  bins: overall.bins,
                  monotonicity_violations: overall.monotonicity_violations,
                  ece: overall.ece,
                  total_n: overall.total_n,
                  prior: overall.prior,
                  threshold_diagnostic: diag,
                },
                precision,
                recall_bounds: recallBounds,
                recall_posterior: recallPosterior,
                ...(breakdowns.by_feed ? { by_feed: breakdowns.by_feed } : {}),
                ...(breakdowns.by_folder ? { by_folder: breakdowns.by_folder } : {}),
                data_summary: data.summary,
                api_cost_z1: data.summary.api_cost_z1,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "recommend_audit_articles",
    "Suggest a small batch of recommend-skip articles to read as audits. Scores candidates by bin uncertainty (CI width on the calibration curve), proximity to the decision threshold, and (optionally) sparse audit coverage. Calls extract_classifier_data with include_population=true to find skip-recommended candidates and analyze_classifier_calibration to source per-bin uncertainty. Same Z1 cost as those calls. Already-audited articles are excluded.",
    {
      count: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of audit candidates to return (default 10)."),
      decision_threshold: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Score threshold for proximity weighting (default 50)."),
      feed: z
        .string()
        .optional()
        .describe("Bias toward candidates from a specific feed (matches feed_title)."),
      prefer_low_audit_coverage: z
        .boolean()
        .optional()
        .describe(
          "Bias toward feeds with few existing audit tags (default false). Useful for spreading audit coverage across feeds.",
        ),
      population_folder: z
        .string()
        .optional()
        .describe("Folder for the population scan."),
      population_months: z
        .number()
        .min(1)
        .max(24)
        .optional()
        .describe("Window in months (default 3)."),
      population_pages: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Page cap (default 30)."),
      bins: z
        .number()
        .min(2)
        .max(50)
        .optional()
        .describe("Bin count for calibration (default 10)."),
      prior_strength: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Beta prior strength (default 4)."),
      refresh: z.boolean().optional(),
    },
    async (params) => {
      const data = await extractClassifierData({
        ...params,
        include_population: true,
      });
      const binCount = params.bins ?? 10;
      const priorStrength = params.prior_strength ?? 4;
      const minBinN = 3;
      const threshold = params.decision_threshold ?? 50;
      const count = params.count ?? 10;

      const calibration = computeCalibration(
        data.verified,
        binCount,
        priorStrength,
        minBinN,
      );
      const binCiWidth = calibration.bins.map((b) => b.ci_high - b.ci_low);

      // Audit coverage per feed (count of existing audit/* tagged articles)
      const auditByFeed = new Map<string, number>();
      for (const r of data.verified) {
        if (r.stratum === "audit") {
          const key = r.feed_title ?? r.feed_id ?? "(unknown)";
          auditByFeed.set(key, (auditByFeed.get(key) ?? 0) + 1);
        }
      }

      const candidates = data.population
        .filter(
          (r) =>
            r.parse_status === "ok" &&
            r.decision === "skip" &&
            r.score !== null,
        )
        .map((r) => {
          const score = r.score!;
          const binIdx = Math.min(Math.floor((score / 100) * binCount), binCount - 1);
          const ciWidth = binCiWidth[binIdx] ?? 0;
          const proximity = 1 / (1 + Math.abs(score - threshold));
          const feedKey = r.feed_title ?? r.feed_id ?? "(unknown)";
          const auditCoverage = auditByFeed.get(feedKey) ?? 0;
          const coverageBonus = params.prefer_low_audit_coverage
            ? 1 / (1 + auditCoverage)
            : 1;
          const feedBoost = params.feed && params.feed === r.feed_title ? 2 : 1;
          const acquisition = ciWidth * proximity * coverageBonus * feedBoost;
          return { row: r, score, binIdx, ciWidth, proximity, acquisition };
        })
        .sort((a, b) => b.acquisition - a.acquisition)
        .slice(0, count);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                candidates: candidates.map((c) => ({
                  id: c.row.id,
                  title: c.row.title,
                  feed: c.row.feed_title,
                  url_score: c.score,
                  bin_index: c.binIdx,
                  bin_ci_width: round4(c.ciWidth),
                  proximity_to_threshold: round4(c.proximity),
                  acquisition_value: round4(c.acquisition),
                  summary_text: c.row.summary_text,
                })),
                instructions:
                  "After reading, tag each article via manage_tags: add_tag='audit/worth-it' if it was worth reading, add_tag='audit/not-worth-it' otherwise. The audit/* tags become the labeled below-threshold data that updates the recall posterior on the next analyze_classifier_calibration run.",
                params: {
                  count,
                  decision_threshold: threshold,
                  prefer_low_audit_coverage: params.prefer_low_audit_coverage ?? false,
                  feed: params.feed ?? null,
                },
                api_cost_z1: data.summary.api_cost_z1,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
