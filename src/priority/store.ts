import { mkdir, open, readFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";

const time = z.number().finite().nonnegative();
const article = z.object({ id: z.string().min(1), timestamp: time });
const audit = z.object({ action: z.string(), reason: z.string(), at: time, config_hash: z.string(), snapshot_id: z.string().optional() });
const preference = z.object({ pin: z.boolean(), exclude: z.boolean(), history: z.array(audit) });
const intent = z.object({ id: z.string(), reason: z.string(), config_hash: z.string(), original_topic_ids: z.array(z.string()), stream_id: z.string(), action: z.enum(["pin", "remove", "auto_add"]), at: time, week: z.string(), snapshot_id: z.string().optional(), status: z.enum(["pending", "verified", "unverified", "not_applied"]), error: z.string().optional() });
const observation = z.object({ first_observed: time, last_complete: time.nullable(), gap_blocked: z.boolean(), articles: z.array(article) });
export const DecisionsSchema = z.object({
  version: z.literal(1), active_snapshot: z.string().nullable(), latest_snapshot: z.string().nullable(),
  preferences: z.record(z.string(), preference), observations: z.record(z.string(), observation),
  membership: z.object({ at: time, ids: z.array(z.string()), since: z.record(z.string(), time) }).nullable(),
  intents: z.array(intent), migrations: z.array(z.object({ old_id: z.string(), new_id: z.string(), at: time, status: z.enum(["pending", "complete"]) })),
});
export type Decisions = z.infer<typeof DecisionsSchema>;
const subscription = z.object({ id: z.string(), title: z.string(), categories: z.array(z.object({ id: z.string(), label: z.string() })), url: z.string(), htmlUrl: z.string(), iconUrl: z.string().optional(), firstitemmsec: z.union([z.string(), z.number().finite()]).optional(), sortid: z.string().optional() });
export const SnapshotSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), config_hash: z.string(), model: z.literal("category-beta-v1"),
  started_at: time, completed_at: time.nullable(), cutoff: time,
  phase: z.enum(["subscriptions", "metadata", "tags", "signals", "volumes", "complete"]),
  source_index: z.number().int().nonnegative(), feed_index: z.number().int().nonnegative(), continuation: z.string().nullable(),
  base_reads: z.number().int().nonnegative(), newest_item_timestamps: z.record(z.string(), time).optional(), subscriptions: z.array(subscription), signal_sources: z.array(z.string()),
  source_coverage: z.record(z.string(), z.boolean()), signals: z.record(z.string(), z.array(article)),
  feed_ids: z.array(z.string()), volumes: z.record(z.string(), z.object({ articles: z.array(article), complete: z.boolean(), observed_at: time.nullable() })),
  prospective: z.record(z.string(), z.object({ articles: z.array(article), first_observed: time, gap_blocked: z.boolean() })),
  membership: z.array(z.string()), errors: z.array(z.string()),
});
export type PrioritySnapshot = z.infer<typeof SnapshotSchema>;
export type Preference = z.infer<typeof preference>;
export const emptyDecisions = (): Decisions => ({ version: 1, active_snapshot: null, latest_snapshot: null, preferences: {}, observations: {}, membership: null, intents: [], migrations: [] });
export function profileDir(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Unsafe profile name");
  return join(process.env.INOREADER_CONFIG_DIR ?? join(homedir(), ".config", "inoreader-mcp"), "priorities", name);
}
function snapshotDir(name: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Unsafe snapshot id");
  return join(profileDir(name), "snapshots", id);
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const parent = join(path, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
async function readValidated<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { throw new Error(`Priority state unavailable or corrupt (${path}); refusing to reset: ${String(error)}`); }
}
export async function readDecisions(name: string): Promise<Decisions> {
  const path = join(profileDir(name), "decisions.json");
  try { await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A missing decisions file beside snapshots is data loss, not first use.
    const files = await readdir(join(profileDir(name), "snapshots")).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    if (files.length) throw new Error("Missing priority decisions beside existing snapshots; refusing reset");
    return emptyDecisions();
  }
  return readValidated(path, DecisionsSchema);
}
export async function saveDecisions(name: string, state: Decisions): Promise<void> { await atomicJson(join(profileDir(name), "decisions.json"), DecisionsSchema.parse(state)); }
export async function readSnapshot(name: string, id: string): Promise<PrioritySnapshot> { return readValidated(join(snapshotDir(name, id), "manifest.json"), SnapshotSchema); }
export async function saveSnapshot(name: string, snapshot: PrioritySnapshot): Promise<void> {
  const validated = SnapshotSchema.parse(snapshot);
  // Immutable content-addressed shards are written first. The atomic manifest is
  // the authoritative cursor/checkpoint, so a crash cannot skip an uncommitted page.
  const dir = snapshotDir(name, snapshot.id);
  const shard = async (prefix: string, data: unknown) => {
    const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const path = join(dir, prefix, `${digest}.json`);
    // The atomic manifest is authoritative; immutable derived shards are never
    // rewritten/fsynced on unrelated page checkpoints.
    try {
      const existing = await stat(path);
      if (!existing.isFile() || (existing.mode & 0o777) !== 0o600) throw new Error(`Invalid or non-private immutable priority shard: ${path}`);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await atomicJson(path, data);
  };
  await shard("signals", validated.signals);
  for (const [id, volume] of Object.entries(validated.volumes)) await shard("feeds", { stream_id: id, ...volume });
  await atomicJson(join(dir, "manifest.json"), validated);
  // Lightweight discovery hint, never an authority for counts/completeness. A
  // crash between these writes is safe: active/latest/requested manifests are
  // always loaded explicitly, and a hint cannot authorize an unvalidated record.
  const metadata = { id: validated.id, started_at: validated.started_at, completed_at: validated.completed_at };
  const metadataPath = join(dir, "metadata.json");
  let previous: unknown;
  try { previous = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (JSON.stringify(previous) !== JSON.stringify(metadata)) await atomicJson(metadataPath, metadata);
}
export const SNAPSHOT_WORKING_WEEKS = 8;
const MetadataSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), started_at: time, completed_at: time.nullable() });
/** Retain every archive on disk, but only parse the most recent eight completed
 * distinct UTC weeks plus explicitly included active/latest/requested IDs. */
export async function listSnapshots(name: string, options: { include_ids?: string[] } = {}): Promise<PrioritySnapshot[]> {
  const ids = await readdir(join(profileDir(name), "snapshots")).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  const metadata: z.infer<typeof MetadataSchema>[] = [];
  // Sequential SMALL metadata reads avoid opening all large manifests at once.
  // Absent/corrupt archive hints are ignored, never repaired by a read. Explicit
  // requests still validate the authoritative manifest and fail closed.
  for (const id of ids) {
    try {
      const value = MetadataSchema.parse(JSON.parse(await readFile(join(snapshotDir(name, id), "metadata.json"), "utf8")));
      if (value.id === id && value.completed_at !== null) metadata.push(value);
    } catch { /* derived archive hint unavailable; do not infer evidence */ }
  }
  metadata.sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id));
  const chosen = new Set(options.include_ids ?? []), weeks = new Set<string>();
  const week = (at: number) => { const d = new Date(at); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
  for (const item of metadata) {
    const key = week(item.started_at);
    if (weeks.has(key)) continue;
    weeks.add(key); chosen.add(item.id);
    if (weeks.size === SNAPSHOT_WORKING_WEEKS) break;
  }
  const snapshots: PrioritySnapshot[] = [];
  for (const id of chosen) snapshots.push(await readSnapshot(name, id));
  return snapshots.sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id));
}
const queues = new Map<string, Promise<unknown>>();
export async function withProfileLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const key = profileDir(name);
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
