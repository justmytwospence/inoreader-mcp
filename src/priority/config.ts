import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as z from "zod/v4";

const nonempty = z.string().trim().min(1).max(8192);
export const ProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  folder: nonempty,
  positive_streams: z.array(nonempty).min(1).max(100).refine(a => new Set(a).size === a.length),
  excluded_topic_folders: z.array(nonempty).default([]),
  window_months: z.number().int().min(1).max(60).default(12),
  prior_strength: z.number().positive().finite().default(10),
  minimum_observations: z.number().int().min(20).default(20),
  minimum_engagements: z.number().int().min(5).default(5),
  maturation_days: z.number().int().min(7).default(7),
  absolute_benchmark_floor: z.number().min(0.2).max(1).default(0.2),
  topic_multiplier: z.number().min(2).finite().default(2),
  promotion_mode: z.enum(["calibrated", "provisional"]).default("calibrated"),
  promotion_probability: z.number().gt(0).lt(1).nullable().default(null),
  auto_add_enabled: z.boolean().default(false),
  calibration: z.object({
    reviewed: z.literal(true), config_hash: z.string().regex(/^[a-f0-9]{64}$/),
    promotion_probability: z.number().gt(0).lt(1), reviewed_at: z.iso.datetime(),
  }).strict().optional(),
  provisional_review: z.object({
    acknowledged_uncalibrated: z.literal(true), config_hash: z.string().regex(/^[a-f0-9]{64}$/),
    promotion_probability: z.number().gt(0).lt(1), reviewed_at: z.iso.datetime(),
  }).strict().optional(),
}).strict();
export type PriorityProfile = z.infer<typeof ProfileSchema>;
export function configHash(profile: PriorityProfile): string {
  const { auto_add_enabled: _a, promotion_probability: _p, calibration: _c, promotion_mode: _m, provisional_review: _r, ...model } = profile;
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}
export function isPromotionReviewed(p: PriorityProfile): boolean {
  if (p.promotion_probability === null) return false;
  if (p.promotion_mode === "provisional") {
    const review = p.provisional_review;
    return p.promotion_probability >= 0.95 && !!review && review.acknowledged_uncalibrated === true && review.config_hash === configHash(p) && review.promotion_probability === p.promotion_probability;
  }
  const review = p.calibration;
  return !!review && review.reviewed === true && review.config_hash === configHash(p) && review.promotion_probability === p.promotion_probability;
}
export function parsePriorityConfig(raw: unknown): PriorityProfile[] {
  const config = z.object({ profiles: z.array(ProfileSchema).min(1).max(50) }).strict().parse(raw);
  if (new Set(config.profiles.map(p => p.name)).size !== config.profiles.length) throw new Error("Duplicate priority profile name");
  if (new Set(config.profiles.map(p => p.folder.trim().toLowerCase())).size !== config.profiles.length) throw new Error("Priority profiles must not share the same folder (trimmed, case-insensitive)");
  for (const p of config.profiles) {
    if (p.positive_streams.some(s => /\/state\/com\.google\/(read|reading-list)$/.test(s) || s === `user/-/label/${p.folder}`)) throw new Error("Read state and operational folders are not positive signals");
    if (p.auto_add_enabled && !isPromotionReviewed(p)) throw new Error(p.promotion_mode === "provisional"
      ? "Auto-add requires explicit uncalibrated provisional review matching model config hash and probability >= 0.95"
      : "Auto-add requires reviewed calibration matching model config hash and probability");
  }
  return config.profiles;
}
export function loadPriorityConfig(): PriorityProfile[] {
  const file = process.env.INOREADER_PRIORITY_CONFIG;
  if (!file) return [];
  if (process.env.MCP_TRANSPORT !== "http") throw new Error("Priority configuration requires MCP_TRANSPORT=http and one writer process");
  return parsePriorityConfig(JSON.parse(readFileSync(file, "utf8")));
}
export function priorityProfile(name: string): PriorityProfile {
  const profile = loadPriorityConfig().find(p => p.name === name);
  if (!profile) throw new Error(`Unknown or disabled priority profile: ${name}`);
  return profile;
}
export function excludedFolders(p: PriorityProfile): string[] { return [...new Set([...p.excluded_topic_folders, p.folder])]; }
