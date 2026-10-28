// Memory/time benchmark for the embedder: embeds N synthetic ~1200-character texts
// (the size of an item's opening) in the worker thread and prints peak RSS.
//
//   docker run --rm --memory 1g --entrypoint node <image> dist/taste/bench.js [N]
//
// INOREADER_TASTE_MODEL_DIR points at the model files (set in the image); without it
// the model is downloaded into a temp directory.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBED_DTYPE, EMBED_MODEL } from "./config.js";
import { createWorkerEmbedder } from "./worker.js";

const n = Number(process.argv[2] ?? process.env.BENCH_N ?? 1500);
if (!Number.isInteger(n) || n < 1) {
  console.error("usage: bench.js [N items, default 1500]");
  process.exit(1);
}

const VOCAB = (
  "the of and to in a is that for it as was with be by on not he this are or his from at which but have an had they " +
  "you were their one all we can her has there been if more when will would who so no out up about into than them " +
  "model data feature signal noise estimate prior posterior sample variance error rate training test score metric " +
  "reader article feed saved essay argument claim evidence method result question answer system design network cost"
).split(" ");

/** A small deterministic generator, so runs are comparable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function text(rand: () => number, chars: number): string {
  let out = "";
  while (out.length < chars) {
    out += VOCAB[Math.floor(rand() * VOCAB.length)] + (rand() < 0.08 ? ". " : " ");
  }
  return out.slice(0, chars);
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
// resourceUsage().maxRSS is in kilobytes.
const maxRssMb = () => mb(process.resourceUsage().maxRSS * 1024);

const rand = rng(42);
const texts = Array.from({ length: n }, () => text(rand, 1200));

const embedder = createWorkerEmbedder(
  {
    model: EMBED_MODEL,
    dtype: EMBED_DTYPE,
    cacheDir: join(mkdtempSync(join(tmpdir(), "taste-bench-")), "models"),
    threads: Number(process.env.INOREADER_TASTE_THREADS ?? 1),
    localModelDir: process.env.INOREADER_TASTE_MODEL_DIR || undefined,
  },
  { idleMs: 0 },
);

const rssBefore = mb(process.memoryUsage().rss);
const t0 = Date.now();
await embedder.embed([texts[0]]); // loads the model
const loadMs = Date.now() - t0;
const rssLoaded = mb(process.memoryUsage().rss);
const t1 = Date.now();
const vectors = await embedder.embed(texts);
const embedMs = Date.now() - t1;
const peak = maxRssMb();
await embedder.close();
await new Promise((r) => setTimeout(r, 1000));

console.log(
  JSON.stringify({
    model: `${EMBED_MODEL} ${EMBED_DTYPE}`,
    items: n,
    chars_per_item: 1200,
    dims: vectors[0].length,
    load_ms: loadMs,
    embed_ms: embedMs,
    ms_per_item: Math.round((embedMs / n) * 10) / 10,
    rss_mb_before: rssBefore,
    rss_mb_model_loaded: rssLoaded,
    max_rss_mb: peak,
    rss_mb_after_close: mb(process.memoryUsage().rss),
  }),
);
process.exit(0);
