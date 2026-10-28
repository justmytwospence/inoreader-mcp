import type { SignalRow } from "../store.js";

/** What a source knows about one page, before it is merged into the index. */
export interface ItemCandidate {
  /** Normalized URL. */
  key: string;
  url: string;
  title: string;
  source_title: string;
  /** Unix seconds. */
  published: number | null;
  opening: string;
  headings: string[];
  words: number;
  /** Cleaned text, capped. */
  text: string;
}

/** One source's result for this sync. Nothing is written until every source has reported. */
export interface SourceBatch {
  source: string;
  /** Every ext_id the source has now, so the rest are removed; null when the listing is incomplete. */
  present: Set<string> | null;
  /** Members that are new or changed. */
  upserts: SignalRow[];
  candidates: ItemCandidate[];
}
