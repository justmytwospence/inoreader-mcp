// Runs the embedding model in a worker thread that comes and goes: it loads on the
// first request, and exits after IDLE_MS without one, so a steady-state server
// holds ~80 MB rather than the model, its runtime arenas and the tokenizer.

import { Worker } from "node:worker_threads";
import type { Embedder, LoadOptions } from "./embed.js";

export type WorkerInit = LoadOptions;

export interface WorkerRequest {
  id: number;
  texts: string[];
}

export type WorkerResponse =
  | { type: "ready"; dims: number }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; vectors: Float32Array[] }
  | { type: "error"; id: number; error: string };

/** The part of `Worker` this module uses, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  on(event: "message", fn: (msg: WorkerResponse) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  terminate(): Promise<unknown> | unknown;
}

export type Spawn = (init: WorkerInit) => WorkerLike;

export const IDLE_MS = 10 * 60_000;
/** Texts per message: bounds one round trip and lets the idle timer see progress. */
const CHUNK = 32;

/** The worker's entry point, next to this file. */
function spawnWorker(init: WorkerInit): WorkerLike {
  return new Worker(new URL("./embedWorker.js", import.meta.url), { workerData: init }) as unknown as WorkerLike;
}

type Pending = { resolve: (v: Float32Array[]) => void; reject: (err: Error) => void };

interface Running {
  worker: WorkerLike;
  ready: Promise<number>;
  pending: Map<number, Pending>;
}

/**
 * An Embedder backed by a lazily started worker thread. A worker that dies is
 * replaced on the next request; requests it was holding fail and their callers
 * (a sync, a search) report or retry them.
 */
export function createWorkerEmbedder(
  init: WorkerInit,
  opts: { idleMs?: number; spawn?: Spawn } = {},
): Embedder & { running(): boolean } {
  const idleMs = opts.idleMs ?? IDLE_MS;
  const spawn = opts.spawn ?? spawnWorker;
  let current: Running | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let nextId = 1;
  let inFlight = 0;

  const clearIdle = () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
  };

  const armIdle = () => {
    clearIdle();
    if (!(idleMs > 0) || !current || inFlight > 0) return;
    idle = setTimeout(() => {
      idle = undefined;
      if (inFlight > 0 || !current) return;
      const run = current;
      current = undefined;
      console.error("[inoreader-mcp] taste: embedding worker idle, unloading the model");
      void Promise.resolve(run.worker.terminate()).catch(() => {});
    }, idleMs);
    idle.unref?.();
  };

  const start = (): Running => {
    if (current) return current;
    const w = spawn(init);
    const pending = new Map<number, Pending>();
    const run: Running = {
      worker: w,
      pending,
      ready: new Promise<number>((resolve, reject) => {
        const failAll = (err: Error) => {
          for (const p of pending.values()) p.reject(err);
          pending.clear();
        };
        w.on("message", (msg) => {
          if (msg.type === "ready") return resolve(msg.dims);
          if (msg.type === "fatal") {
            reject(new Error(`embedding model failed to load: ${msg.error}`));
            if (current === run) current = undefined;
            void Promise.resolve(w.terminate()).catch(() => {});
            return;
          }
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.type === "error") p.reject(new Error(msg.error));
          else p.resolve(msg.vectors);
        });
        w.on("error", (err) => {
          reject(err);
          failAll(err);
          if (current === run) current = undefined;
        });
        w.on("exit", (code) => {
          if (current === run) current = undefined;
          reject(new Error(`embedding worker exited (code ${code}) before it was ready`));
          failAll(new Error(`embedding worker exited (code ${code})`));
        });
      }),
    };
    run.ready.catch(() => {}); // surfaced to callers through call(); never an unhandled rejection
    current = run;
    return run;
  };

  const call = async (texts: string[]): Promise<Float32Array[]> => {
    if (closed) throw new Error("embedder is closed");
    const run = start();
    await run.ready;
    return new Promise<Float32Array[]>((resolve, reject) => {
      if (current !== run) return reject(new Error("embedding worker is not running"));
      const id = nextId++;
      run.pending.set(id, { resolve, reject });
      run.worker.postMessage({ id, texts });
    });
  };

  return {
    model: init.model,
    dtype: init.dtype,
    running: () => current !== undefined,
    async embed(texts) {
      inFlight++;
      clearIdle();
      try {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += CHUNK) out.push(...(await call(texts.slice(i, i + CHUNK))));
        return out;
      } finally {
        inFlight--;
        armIdle();
      }
    },
    async close() {
      closed = true;
      clearIdle();
      const run = current;
      current = undefined;
      if (run) {
        for (const p of run.pending.values()) p.reject(new Error("embedder is closed"));
        run.pending.clear();
        await run.worker.terminate();
      }
    },
  };
}
