// The embedding worker thread: loads the model in its own thread and answers embed
// requests from the main thread. Tokenizing and running the model is CPU-bound;
// on the main thread it would stall every request, /health included. See worker.ts.

import { parentPort, workerData } from "node:worker_threads";
import { loadEmbedder, type LoadOptions } from "./embed.js";
import type { WorkerRequest, WorkerResponse } from "./worker.js";

if (!parentPort) throw new Error("embedWorker.js must run as a worker thread");
const port = parentPort;
const ready = loadEmbedder(workerData as LoadOptions);

const send = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);

ready.then(
  (e) => send({ type: "ready", dims: e.dims }),
  (err) => send({ type: "fatal", error: err instanceof Error ? err.stack || err.message : String(err) }),
);

port.on("message", async (req: WorkerRequest) => {
  try {
    const e = await ready;
    const vectors = await e.embed(req.texts);
    send({ type: "result", id: req.id, vectors }, [...new Set(vectors.map((v) => v.buffer as ArrayBuffer))]);
  } catch (err) {
    send({ type: "error", id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
});
