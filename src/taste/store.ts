import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

// node:sqlite is loaded when a store is first opened, not when this module is
// imported: a server without the taste index never loads it (and never prints its
// experimental-feature warning on Node versions that have one).
const requireModule = createRequire(import.meta.url);
const openDatabase = (file: string): DatabaseSync => {
  const { DatabaseSync: Database } = requireModule("node:sqlite") as typeof import("node:sqlite");
  return new Database(file);
};

// The taste index on disk: node:sqlite, vectors as Float32 BLOBs. Nothing here
// cannot be rebuilt from Inoreader and Karakeep (a rebuild costs ~15 Zone 1 reads),
// so a changed identity or a damaged file simply starts over. Search is not done
// here: loadMatrix() hands the vectors to an exact in-memory scan.

const SCHEMA_VERSION = "1";

export interface Highlight {
  id: string;
  text: string;
  note: string;
  /** Unix seconds. */
  added_on: number | null;
}

export interface ItemRow {
  /** Normalized URL. */
  key: string;
  /** The URL as first seen. */
  url: string;
  title: string;
  /** Feed or publisher name. */
  source_title: string;
  /** Unix seconds. */
  published: number | null;
  opening: string;
  headings: string[];
  words: number;
  /** Cleaned full text (capped); null for items only in the widest tier. */
  text: string | null;
  updated_at: number;
}

/**
 * One source's membership of an item. `key` is null for a member the source knows
 * about but that was judged not worth indexing (no URL, not an article): remembering
 * it avoids fetching it again on every sync. `ext_id` is namespaced by the source
 * adapter ("ino:<hex>", "kk:<id>"). `fp` fingerprints what the judgement was based on.
 */
export interface SignalRow {
  source: string;
  ext_id: string;
  key: string | null;
  fp: string;
  /** Unix seconds when the source says it was saved, if it says. */
  added_at: number | null;
  highlights: Highlight[];
}

export interface VectorMatrix {
  keys: string[];
  dims: number;
  /** keys.length rows of `dims` floats. */
  data: Float32Array;
}

const TABLES = `
  CREATE TABLE items (
    key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    source_title TEXT NOT NULL,
    published INTEGER,
    opening TEXT NOT NULL,
    headings TEXT NOT NULL,
    words INTEGER NOT NULL,
    text TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE signals (
    source TEXT NOT NULL,
    ext_id TEXT NOT NULL,
    key TEXT,
    fp TEXT NOT NULL,
    added_at INTEGER,
    highlights TEXT NOT NULL,
    PRIMARY KEY (source, ext_id)
  );
  CREATE INDEX signals_key ON signals(key);
  CREATE INDEX signals_ext_id ON signals(ext_id);
  CREATE TABLE vectors (
    key TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL
  );
`;

function removeFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
}

export class TasteStore {
  private db!: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  /** True when this open found a changed identity or a damaged file and started over. */
  readonly rebuilt: boolean;

  constructor(
    private readonly file: string,
    /** schema:model:dtype */
    readonly identity: string,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    let rebuilt = false;
    try {
      this.db = this.open();
      rebuilt = this.ensureIdentity();
    } catch {
      // Not a database, or one that fails its integrity check: rebuildable, so start over.
      try {
        this.db?.close();
      } catch {
        /* already unusable */
      }
      if (file !== ":memory:") removeFiles(file);
      this.db = this.open();
      this.ensureIdentity();
      rebuilt = true;
    }
    this.rebuilt = rebuilt;
  }

  static identityFor(model: string, dtype: string): string {
    return `${SCHEMA_VERSION}:${model}:${dtype}`;
  }

  private open(): DatabaseSync {
    const db = openDatabase(this.file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const check = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("quick_check failed");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return db;
  }

  /** Returns true when the index was (re)created. */
  private ensureIdentity(): boolean {
    const have = this.getMeta("identity");
    const hasTables = (this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'items'").get() as { n: number }).n > 0;
    if (have === this.identity && hasTables) return false;
    this.db.exec(`
      DROP TABLE IF EXISTS vectors;
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS items;
      DELETE FROM meta;
    `);
    this.db.exec(TABLES);
    this.setMeta("identity", this.identity);
    return have !== null;
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /** All-or-nothing: a throw inside `fn` leaves the index as it was. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing open */
      }
      throw e;
    }
  }

  // --- meta -------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.getMeta(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  // --- items ------------------------------------------------------------

  upsertItem(item: ItemRow): void {
    this.stmt(`
      INSERT INTO items (key, url, title, source_title, published, opening, headings, words, text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET url = excluded.url, title = excluded.title, source_title = excluded.source_title,
        published = excluded.published, opening = excluded.opening, headings = excluded.headings,
        words = excluded.words, text = excluded.text, updated_at = excluded.updated_at
    `).run(item.key, item.url, item.title, item.source_title, item.published, item.opening, JSON.stringify(item.headings), item.words, item.text, item.updated_at);
  }

  private toItem(row: Record<string, any>): ItemRow {
    return { ...(row as ItemRow), headings: JSON.parse(row.headings) as string[] };
  }

  getItem(key: string): ItemRow | undefined {
    const row = this.stmt("SELECT * FROM items WHERE key = ?").get(key) as Record<string, any> | undefined;
    return row ? this.toItem(row) : undefined;
  }

  allItems(): ItemRow[] {
    return (this.stmt("SELECT * FROM items").all() as Array<Record<string, any>>).map((r) => this.toItem(r));
  }

  itemCount(): number {
    return (this.stmt("SELECT count(*) AS n FROM items").get() as { n: number }).n;
  }

  // --- signals ----------------------------------------------------------

  private toSignal(row: Record<string, any>): SignalRow {
    return { ...(row as SignalRow), highlights: JSON.parse(row.highlights) as Highlight[] };
  }

  putSignal(s: SignalRow): void {
    this.stmt(`
      INSERT INTO signals (source, ext_id, key, fp, added_at, highlights) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, ext_id) DO UPDATE SET key = excluded.key, fp = excluded.fp,
        added_at = excluded.added_at, highlights = excluded.highlights
    `).run(s.source, s.ext_id, s.key, s.fp, s.added_at, JSON.stringify(s.highlights));
  }

  /** Every member a source has recorded, including those judged not indexable. */
  signalsOf(source: string): Map<string, SignalRow> {
    const rows = this.stmt("SELECT * FROM signals WHERE source = ?").all(source) as Array<Record<string, any>>;
    return new Map(rows.map((r) => [r.ext_id as string, this.toSignal(r)]));
  }

  /** The key an Inoreader/Karakeep member resolved to in any source, if it was seen before. */
  keyOfExtId(extId: string): { key: string | null } | undefined {
    const row = this.stmt("SELECT key FROM signals WHERE ext_id = ? ORDER BY key IS NULL LIMIT 1").get(extId) as { key: string | null } | undefined;
    return row ? { key: row.key } : undefined;
  }

  deleteSignals(source: string, extIds: Iterable<string>): number {
    let n = 0;
    for (const id of extIds) n += Number(this.stmt("DELETE FROM signals WHERE source = ? AND ext_id = ?").run(source, id).changes);
    return n;
  }

  /** Drops the signals of sources no longer in the config. */
  pruneSources(keep: string[]): number {
    const known = (this.stmt("SELECT DISTINCT source FROM signals").all() as Array<{ source: string }>).map((r) => r.source);
    let n = 0;
    for (const s of known) {
      if (!keep.includes(s)) n += Number(this.stmt("DELETE FROM signals WHERE source = ?").run(s).changes);
    }
    return n;
  }

  signalsFor(key: string): SignalRow[] {
    return (this.stmt("SELECT * FROM signals WHERE key = ?").all(key) as Array<Record<string, any>>).map((r) => this.toSignal(r));
  }

  signalsByKey(): Map<string, SignalRow[]> {
    const out = new Map<string, SignalRow[]>();
    for (const r of this.stmt("SELECT * FROM signals WHERE key IS NOT NULL").all() as Array<Record<string, any>>) {
      const s = this.toSignal(r);
      const list = out.get(s.key!);
      if (list) list.push(s);
      else out.set(s.key!, [s]);
    }
    return out;
  }

  /** Keys that have at least one signal from one of these sources. */
  keysForSources(sources: string[]): Set<string> {
    const keys = new Set<string>();
    for (const s of sources) {
      for (const r of this.stmt("SELECT DISTINCT key FROM signals WHERE source = ? AND key IS NOT NULL").all(s) as Array<{ key: string }>) {
        keys.add(r.key);
      }
    }
    return keys;
  }

  /** Distinct indexed items per source. */
  countsBySource(): Record<string, number> {
    const rows = this.stmt("SELECT source, count(DISTINCT key) AS n FROM signals WHERE key IS NOT NULL GROUP BY source").all() as Array<{ source: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.source, r.n]));
  }

  /** Deletes items (and their vectors) that no signal points to any more. Returns how many. */
  gc(): number {
    this.stmt("DELETE FROM vectors WHERE key NOT IN (SELECT key FROM signals WHERE key IS NOT NULL)").run();
    return Number(this.stmt("DELETE FROM items WHERE key NOT IN (SELECT key FROM signals WHERE key IS NOT NULL)").run().changes);
  }

  // --- vectors ----------------------------------------------------------

  putVector(key: string, hash: string, vec: Float32Array): void {
    this.stmt(`
      INSERT INTO vectors (key, hash, dims, vec) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, dims = excluded.dims, vec = excluded.vec
    `).run(key, hash, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  vectorHashes(): Map<string, string> {
    const rows = this.stmt("SELECT key, hash FROM vectors").all() as Array<{ key: string; hash: string }>;
    return new Map(rows.map((r) => [r.key, r.hash]));
  }

  vectorCount(): number {
    return (this.stmt("SELECT count(*) AS n FROM vectors").get() as { n: number }).n;
  }

  /** Every vector, as one row-major matrix in a stable order. */
  loadMatrix(): VectorMatrix {
    const rows = this.stmt("SELECT key, dims, vec FROM vectors ORDER BY key").all() as Array<{ key: string; dims: number; vec: Uint8Array }>;
    if (!rows.length) return { keys: [], dims: 0, data: new Float32Array(0) };
    const dims = rows[0].dims;
    const usable = rows.filter((r) => r.dims === dims && r.vec.byteLength === dims * 4);
    const data = new Float32Array(usable.length * dims);
    usable.forEach((r, i) => {
      const copy = new Uint8Array(r.vec.byteLength);
      copy.set(r.vec);
      data.set(new Float32Array(copy.buffer), i * dims);
    });
    return { keys: usable.map((r) => r.key), dims, data };
  }
}
