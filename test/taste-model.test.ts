import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMBED_DTYPE, EMBED_MODEL } from "../src/taste/config.js";
import { loadEmbedder } from "../src/taste/embed.js";
import { embedInput } from "../src/taste/text.js";
import { createWorkerEmbedder } from "../src/taste/worker.js";

// The real q8 model. Skipped unless asked for, because it needs the model files:
//   INOREADER_MCP_MODEL_TESTS=1 npm test
// INOREADER_TASTE_MODEL_DIR points at a directory holding Xenova/bge-small-en-v1.5/
// (config, tokenizer files and onnx/model_quantized.onnx); without it the model is
// downloaded (~34 MB) into a temp cache.
const enabled = process.env.INOREADER_MCP_MODEL_TESTS === "1";

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

const essay = {
  title: "Microservices are mostly a coordination tax",
  opening:
    "Most teams adopt microservices for the wrong reasons. They expect independent scaling and faster releases, " +
    "but what they actually buy is a bill for coordination: every boundary between services becomes a contract " +
    "that two teams must negotiate, version and keep alive. A well-structured modular monolith gets most of the " +
    "benefit of clear boundaries without paying that price until the organization really needs to.",
};
const thesis = "Microservices mostly add coordination costs between teams, so a modular monolith is usually the better choice.";
const paraphrase =
  "Teams usually adopt microservices for the wrong reasons: what they really pay for is coordination between teams, which a modular monolith mostly avoids.";
// A looser rewording and a text on a neighbouring topic, to show where the scale sits.
const loose =
  "Companies tend to pick a microservice architecture for poor reasons; the real price is the extra effort teams spend " +
  "agreeing on interfaces, which a carefully modularized single deployable avoids.";
const adjacent = "Kubernetes clusters need careful capacity planning, autoscaling policies and observability to avoid surprise outages in production.";
const unrelated =
  "Mix flour, water and an active starter, fold the dough every thirty minutes, then bake it overnight in a very hot Dutch oven for a crisp crust.";

test(
  "the q8 model ranks a paraphrase of an essay's thesis at or above 0.75 and an unrelated text below 0.6",
  { skip: !enabled, timeout: 300_000 },
  async () => {
    const embedder = createWorkerEmbedder(
      {
        model: EMBED_MODEL,
        dtype: EMBED_DTYPE,
        cacheDir: join(tmpdir(), "inoreader-mcp-models"),
        threads: 1,
        localModelDir: process.env.INOREADER_TASTE_MODEL_DIR || undefined,
      },
      { idleMs: 0 },
    );
    try {
      // Items and ideas are both embedded as passages: no BGE query prefix on either side.
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const [item, thesisVec, paraphraseVec, unrelatedVec, looseVec, adjacentVec] = await embedder.embed([
        embedInput(essay.title, essay.opening),
        thesis,
        paraphrase,
        unrelated,
        loose,
        adjacent,
      ]);
      clearInterval(timer);

      assert.equal(item.length, 384);
      assert.ok(Math.abs(dot(item, item) - 1) < 1e-3, "vectors are normalized");

      const thesisToItem = dot(thesisVec, item);
      const paraphraseToItem = dot(paraphraseVec, item);
      const paraphraseToThesis = dot(paraphraseVec, thesisVec);
      const unrelatedToItem = dot(unrelatedVec, item);
      const unrelatedToThesis = dot(unrelatedVec, thesisVec);
      console.log(
        `model similarities: thesis~essay ${thesisToItem.toFixed(3)}, paraphrase~essay ${paraphraseToItem.toFixed(3)}, ` +
          `paraphrase~thesis ${paraphraseToThesis.toFixed(3)}, unrelated~essay ${unrelatedToItem.toFixed(3)}, ` +
          `unrelated~thesis ${unrelatedToThesis.toFixed(3)}, loose paraphrase~essay ${dot(looseVec, item).toFixed(3)}, ` +
          `adjacent topic~essay ${dot(adjacentVec, item).toFixed(3)}`,
      );

      assert.ok(paraphraseToItem >= 0.75, `paraphrase vs essay ${paraphraseToItem}`);
      assert.ok(paraphraseToThesis >= 0.75, `paraphrase vs thesis ${paraphraseToThesis}`);
      assert.ok(unrelatedToItem < 0.6, `unrelated vs essay ${unrelatedToItem}`);
      assert.ok(unrelatedToThesis < 0.6, `unrelated vs thesis ${unrelatedToThesis}`);
      assert.ok(paraphraseToItem > dot(adjacentVec, item) && dot(adjacentVec, item) > unrelatedToItem, "paraphrase > neighbouring topic > unrelated");
      assert.ok(ticks > 5, `the main thread kept running while the worker embedded (${ticks} ticks)`);

      // The worker thread embeds what the same model does in this thread. Not bit for bit
      // across batches: the q8 model quantizes activations per batch, so a text embedded
      // alone differs slightly from the same text embedded beside others.
      const local = await loadEmbedder({
        model: EMBED_MODEL, dtype: EMBED_DTYPE, cacheDir: join(tmpdir(), "inoreader-mcp-models"), threads: 1,
        localModelDir: process.env.INOREADER_TASTE_MODEL_DIR || undefined,
      });
      assert.equal(local.dims, 384);
      const [same] = await local.embed([thesis]);
      const agreement = dot(same, thesisVec);
      console.log(`same text, alone in this thread vs in a batch in the worker: cosine ${agreement.toFixed(5)}`);
      assert.ok(agreement > 0.98, `cosine ${agreement}`);
    } finally {
      await embedder.close();
    }
  },
);
