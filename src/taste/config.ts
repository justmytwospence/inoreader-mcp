import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

// The taste index is generic: nothing here names a tag, label, tier or Karakeep
// instance. What is indexed and how it is grouped comes from a JSON file named by
// INOREADER_TASTE_CONFIG. Without one, the built-in default indexes what every
// Inoreader account has: starred items and annotated (highlighted) items.

/** The embedding model and precision. Part of the store's identity: a change rebuilds the index. */
export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DTYPE = "q8";

export const STARRED_STREAM = "user/-/state/com.google/starred";

export class TasteConfigError extends Error {}

const Name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "must be 1-32 characters: letters, digits, '_' or '-'");
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const StreamSource = z.strictObject({
  name: Name,
  type: z.literal("inoreader-stream"),
  /** Any stream ID: a label, a folder, starred, saved web pages. */
  stream: z.string().min(1),
});
const AnnotationsSource = z.strictObject({
  name: Name,
  type: z.literal("inoreader-annotations"),
});
const KarakeepSource = z.strictObject({
  name: Name,
  type: z.literal("karakeep"),
  /** Names of the environment variables that hold the base URL and API key: the file holds no secrets. */
  url_env: EnvName,
  key_env: EnvName,
  /** Fallback article test when Karakeep's own reader-view classifier has no definite answer. */
  min_words: z.number().int().min(0).max(100_000).default(300),
  /** Prefer Karakeep's reader-view classifier (readable / not_readable) over the word count. */
  use_reader_view: z.boolean().default(true),
});
const SourceSchema = z.discriminatedUnion("type", [StreamSource, AnnotationsSource, KarakeepSource]);

const TierSchema = z.strictObject({
  name: Name,
  /** Source names, or "*" for all of them. */
  sources: z.array(z.string().min(1)).min(1),
});

const ConfigSchema = z.strictObject({
  sources: z.array(SourceSchema).min(1),
  tiers: z.array(TierSchema).min(1).optional(),
  default_tier: Name.optional(),
  novelty_threshold: z.number().gt(0).lte(1).default(0.75),
});

export type TasteSource = z.infer<typeof SourceSchema>;
export type KarakeepConfig = z.infer<typeof KarakeepSource>;
export interface TasteTier {
  name: string;
  /** Source names with "*" already expanded. */
  sources: string[];
}
export interface TasteConfig {
  sources: TasteSource[];
  /** Ordered narrowest first. */
  tiers: TasteTier[];
  default_tier: string;
  novelty_threshold: number;
}

export const DEFAULT_CONFIG_INPUT = {
  sources: [
    { name: "starred", type: "inoreader-stream", stream: STARRED_STREAM },
    { name: "highlights", type: "inoreader-annotations" },
  ],
  tiers: [
    { name: "highlights", sources: ["highlights"] },
    { name: "saved", sources: ["*"] },
  ],
  default_tier: "saved",
  novelty_threshold: 0.75,
};

/** Validates a config object. Every problem is reported at once, with its location. */
export function parseTasteConfig(raw: unknown, origin = "taste config"): TasteConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new TasteConfigError(`Invalid ${origin}:\n${lines.join("\n")}`);
  }
  const cfg = parsed.data;
  const problems: string[] = [];

  const names = new Set<string>();
  for (const s of cfg.sources) {
    if (names.has(s.name)) problems.push(`duplicate source name "${s.name}"`);
    names.add(s.name);
  }
  const rawTiers = cfg.tiers ?? [{ name: "all", sources: ["*"] }];
  const tierNames = new Set<string>();
  const tiers: TasteTier[] = [];
  for (const t of rawTiers) {
    if (tierNames.has(t.name)) problems.push(`duplicate tier name "${t.name}"`);
    tierNames.add(t.name);
    const members = new Set<string>();
    for (const s of t.sources) {
      if (s === "*") for (const n of names) members.add(n);
      else if (!names.has(s)) problems.push(`tier "${t.name}" lists unknown source "${s}" (known: ${[...names].join(", ")})`);
      else members.add(s);
    }
    tiers.push({ name: t.name, sources: [...members] });
  }
  const defaultTier = cfg.default_tier ?? tiers[tiers.length - 1].name;
  if (!tierNames.has(defaultTier)) {
    problems.push(`default_tier "${defaultTier}" is not a tier (tiers: ${[...tierNames].join(", ")})`);
  }
  if (problems.length) throw new TasteConfigError(`Invalid ${origin}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return { sources: cfg.sources, tiers, default_tier: defaultTier, novelty_threshold: cfg.novelty_threshold };
}

export function tasteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true)$/i.test(env.INOREADER_TASTE_INDEX ?? "");
}

/** The configured file, or the built-in starred + highlights default when the variable is unset. */
export function loadTasteConfig(env: NodeJS.ProcessEnv = process.env): TasteConfig {
  const file = env.INOREADER_TASTE_CONFIG;
  if (!file) return parseTasteConfig(DEFAULT_CONFIG_INPUT, "built-in taste config");
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    throw new TasteConfigError(`INOREADER_TASTE_CONFIG: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new TasteConfigError(`INOREADER_TASTE_CONFIG: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseTasteConfig(json, `INOREADER_TASTE_CONFIG (${file})`);
}

export interface TasteSettings {
  config: TasteConfig;
  /** `<INOREADER_CONFIG_DIR>/taste`: the index, and the model cache when no model dir is set. */
  dataDir: string;
  dbPath: string;
  /** A directory holding `<model>/` files. Set, nothing is downloaded. */
  modelDir?: string;
  threads: number;
}

export function loadTasteSettings(env: NodeJS.ProcessEnv = process.env): TasteSettings {
  const config = loadTasteConfig(env);
  const base = env.INOREADER_CONFIG_DIR ?? join(homedir(), ".config", "inoreader-mcp");
  const dataDir = join(base, "taste");
  const threads = Number(env.INOREADER_TASTE_THREADS ?? 1);
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) {
    throw new TasteConfigError(`INOREADER_TASTE_THREADS must be an integer from 1 to 16, got "${env.INOREADER_TASTE_THREADS}"`);
  }
  return {
    config,
    dataDir,
    dbPath: join(dataDir, "index.sqlite"),
    modelDir: env.INOREADER_TASTE_MODEL_DIR || undefined,
    threads,
  };
}

/** Karakeep credentials come only from the environment variables the config names. */
export function karakeepCredentials(
  source: KarakeepConfig,
  env: NodeJS.ProcessEnv = process.env,
): { url: string; key: string } {
  const url = env[source.url_env]?.trim();
  const key = env[source.key_env]?.trim();
  const missing = [!url && source.url_env, !key && source.key_env].filter(Boolean);
  if (missing.length) throw new Error(`source "${source.name}": environment variable(s) not set: ${missing.join(", ")}`);
  return { url: url!.replace(/\/+$/, ""), key: key! };
}
