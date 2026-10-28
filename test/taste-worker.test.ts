import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createWorkerEmbedder, type Spawn, type WorkerLike, type WorkerRequest } from "../src/taste/worker.js";

const init = { model: "m", dtype: "q8", cacheDir: "/tmp/x", threads: 1 };

/** A worker that answers like embedWorker.ts: ready, then one vector per text. */
class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false;
  requests: WorkerRequest[] = [];
  constructor(private readonly mode: "ok" | "fatal" | "die" = "ok") {
    super();
    queueMicrotask(() => {
      if (mode === "fatal") this.emit("message", { type: "fatal", error: "no model" });
      else this.emit("message", { type: "ready", dims: 2 });
    });
  }
  postMessage(msg: WorkerRequest) {
    this.requests.push(msg);
    queueMicrotask(() => {
      if (this.mode === "die") return void this.emit("exit", 1);
      this.emit("message", { type: "result", id: msg.id, vectors: msg.texts.map((t) => Float32Array.from([t.length, 1])) });
    });
  }
  async terminate() {
    this.terminated = true;
    this.emit("exit", 1);
    return 1;
  }
}

function harness(modes: Array<"ok" | "fatal" | "die"> = ["ok"]) {
  const workers: FakeWorker[] = [];
  const spawn: Spawn = () => {
    const w = new FakeWorker(modes[Math.min(workers.length, modes.length - 1)]);
    workers.push(w);
    return w;
  };
  return { workers, spawn };
}

test("the worker starts on first use, not before", async () => {
  const { workers, spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn, idleMs: 0 });
  assert.equal(workers.length, 0);
  assert.equal(e.running(), false);
  assert.deepEqual((await e.embed(["abc", "de"])).map((v) => [...v]), [[3, 1], [2, 1]]);
  assert.equal(workers.length, 1);
  assert.equal(e.running(), true);
  assert.deepEqual(await e.embed([]), []);
  await e.close();
  assert.equal(workers[0].terminated, true);
});

test("many texts go to the worker in bounded messages, in order", async () => {
  const { workers, spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn, idleMs: 0 });
  const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
  const out = await e.embed(texts);
  assert.deepEqual(out.map((v) => v[0]), texts.map((t) => t.length));
  assert.deepEqual(workers[0].requests.map((r) => r.texts.length), [32, 32, 6]);
  await e.close();
});

test("an idle worker is terminated and the next request starts a new one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workers, spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn, idleMs: 600_000 });
  await e.embed(["a"]);
  assert.equal(e.running(), true);
  t.mock.timers.tick(599_999);
  assert.equal(e.running(), true, "not before ten minutes");
  t.mock.timers.tick(1);
  assert.equal(e.running(), false);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual((await e.embed(["abcd"])).map((v) => v[0]), [4]);
  assert.equal(workers.length, 2);
  await e.close();
});

test("the idle clock restarts with each request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workers, spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn, idleMs: 600_000 });
  for (let i = 0; i < 4; i++) {
    await e.embed(["a"]);
    t.mock.timers.tick(400_000); // 400 s apart: 1,600 s in all, never 600 s idle
  }
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  t.mock.timers.tick(200_000);
  assert.equal(workers[0].terminated, true);
  await e.close();
});

test("the default idle time is ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workers, spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn });
  await e.embed(["a"]);
  t.mock.timers.tick(9 * 60_000);
  assert.equal(workers[0].terminated, false);
  t.mock.timers.tick(60_000);
  assert.equal(workers[0].terminated, true);
  await e.close();
});

test("a model that fails to load rejects, and the next request tries again", async () => {
  const { workers, spawn } = harness(["fatal", "ok"]);
  const e = createWorkerEmbedder(init, { spawn, idleMs: 0 });
  await assert.rejects(e.embed(["a"]), /model failed to load: no model/);
  assert.equal(e.running(), false);
  assert.deepEqual((await e.embed(["abc"])).map((v) => v[0]), [3]);
  assert.equal(workers.length, 2);
  await e.close();
});

test("a worker that dies mid-request fails that request and is replaced after", async () => {
  const { workers, spawn } = harness(["die", "ok"]);
  const e = createWorkerEmbedder(init, { spawn, idleMs: 0 });
  await assert.rejects(e.embed(["a"]), /exited/);
  assert.equal(e.running(), false);
  assert.deepEqual((await e.embed(["ab"])).map((v) => v[0]), [2]);
  assert.equal(workers.length, 2);
  await e.close();
});

test("a closed embedder refuses work", async () => {
  const { spawn } = harness();
  const e = createWorkerEmbedder(init, { spawn, idleMs: 0 });
  await e.close();
  await assert.rejects(e.embed(["a"]), /closed/);
});
