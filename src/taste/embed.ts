// The embedding model, in whichever thread loads it. Production loads it in a
// worker thread (see worker.ts); nothing on the main thread imports
// @huggingface/transformers, so a server without the taste index never loads it.

/** The model as the rest of the index uses it. */
export interface Embedder {
  readonly model: string;
  readonly dtype: string;
  /** One normalized vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

/** The model loaded in this thread. */
export interface LocalEmbedder {
  readonly model: string;
  readonly dtype: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface LoadOptions {
  model: string;
  dtype: string;
  /** Where downloaded files are cached (used when `localModelDir` is not set). */
  cacheDir: string;
  threads: number;
  /** A directory holding `<model>/` files; when set, nothing is downloaded. */
  localModelDir?: string;
}

/** Texts per ONNX run: bounds the arena. Truncation to the model's 512 tokens is the tokenizer's. */
export const BATCH_SIZE = 8;

/**
 * Local ONNX embeddings through transformers.js: CPU only, no network when
 * `localModelDir` is set. Items and ideas are both embedded as passages, with no
 * BGE query prefix: claim-to-essay similarity is symmetric, and the spike that chose
 * this model measured it that way.
 */
export async function loadEmbedder(opts: LoadOptions): Promise<LocalEmbedder> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = opts.cacheDir;
  if (opts.localModelDir) {
    env.localModelPath = opts.localModelDir;
    env.allowRemoteModels = false;
  }
  const extractor = await pipeline("feature-extraction", opts.model, {
    dtype: opts.dtype as "q8",
    session_options: { intraOpNumThreads: opts.threads, interOpNumThreads: 1 },
  });
  const probe = await extractor(["probe"], { pooling: "cls", normalize: true });
  const dims = probe.dims[probe.dims.length - 1];

  return {
    model: opts.model,
    dtype: opts.dtype,
    dims,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const res = await extractor(batch, { pooling: "cls", normalize: true });
        const data = res.data as Float32Array;
        batch.forEach((_, j) => out.push(data.slice(j * dims, (j + 1) * dims)));
      }
      return out;
    },
  };
}
