import { ensureValidToken } from "./auth.js";
import { assertBudget, noteRequest, setCooldown, updateFromHeaders } from "./rate-limit.js";
import { withHttpSlot } from "./concurrency.js";

const BASE_URL = "https://www.inoreader.com";

// Every read goes to Inoreader. There is deliberately no response cache: the user
// edits subscriptions in Inoreader's own apps, which this process never hears about,
// so no invalidation scheme can keep a cached read correct. The old module-level
// cache had no expiry and was only harmless while mcpjungle spawned a fresh process
// per tool call; once the server ran as one long-lived HTTP process, it served an
// eight-day-old subscription list and the organize workflow never saw new feeds.

// Zone is a property of the endpoint, not of the HTTP verb. Most POSTs are Zone 2
// writes, but stream/items/contents is a POST purely because the id list is too
// long for a query string -- it is a Zone 1 read. Deriving the zone from the method
// would quietly mis-bill it against the write budget.
const ZONE1_POST_PATHS = new Set(["/reader/api/0/stream/items/contents"]);

// No request had a timeout before. mcpjungle spawns this server per tool call and
// the tool-call path has no timeout of its own, so one hung connection hung the
// whole MCP request indefinitely.
const TIMEOUT_MS = 20_000;

const RETRY = { maxAttempts: 4, baseMs: 500, maxMs: 20_000, ceilingMs: 60_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retryable means "the server told us to come back", not "the request failed".
 * A 400 is a bug in our request and retrying it just burns budget -- the previous
 * retry loop retried a 400 exactly as eagerly as a 429.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After is either delta-seconds or an HTTP date. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw.trim())) {
    const ms = Number(raw) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Full jitter, so a batch that trips a limit does not retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(RETRY.maxMs, RETRY.baseMs * 2 ** attempt);
}

/** Reads alone may retry. Writes with lost/5xx responses have ambiguous outcomes:
 * never replay them here. Bulk writers reconcile only after observed read-back.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string, zone: 1 | 2, reserve = 0): Promise<Response> {
  const maxAttempts = zone === 1 ? RETRY.maxAttempts : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Admission and accounting are outside the transport catch: quota decisions
    // must not be mistaken for transient fetch failures.
    assertBudget(zone, 1, label, reserve);
    const counts = noteRequest(zone);
    let res: Response;
    try {
      // Do not hide redirect hops from accounting or replay a POST via 307/308.
      res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt + 1 === maxAttempts) {
        throw new Error(`Inoreader request failed on ${label} after ${attempt + 1} attempt(s): ${String(e)}${zone === 2 ? ". Outcome unknown; read back before any further write. Not replayed." : ""}`);
      }
      await sleep(backoffMs(attempt));
      continue;
    }
    updateFromHeaders(res.headers, counts); // every response, including errors/retries
    const retry = isRetryableStatus(res.status);
    const wait = retry ? Math.max(retryAfterMs(res) ?? (res.status === 429 ? 1000 : 0), backoffMs(attempt)) : 0;
    if (res.status === 429 || (retry && res.headers.has("retry-after"))) setCooldown(zone, wait);
    if (!retry || attempt + 1 === maxAttempts) return res;
    await res.body?.cancel();
    if (wait > RETRY.ceilingMs) {
      throw new Error(`Inoreader asked us to back off ${Math.ceil(wait / 1000)}s on ${label}; cooldown persisted, not sleeping past 60s.`);
    }
    await sleep(wait);
  }
  throw new Error(`Unreachable retry state on ${label}`);
}

export async function apiGet<T>(path: string, params?: Record<string, string | string[]>, options?: { reserve?: number }): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== "") url.searchParams.append(k, item);
        }
      } else if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }

  const token = await ensureValidToken();
  return withHttpSlot(async () => {
  const res = await fetchWithRetry(
    url.toString(),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "inoreader-mcp/0.1.0",
      },
    },
    `GET ${path}`, 1, options?.reserve
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Inoreader API error ${res.status} on GET ${path}: ${text.slice(0, 2000)}`);
  }

  return await res.json() as T;
  });
}

export async function apiPost<T>(
  path: string,
  body?: Record<string, string> | URLSearchParams,
  params?: Record<string, string>,
  options?: { expectOk?: boolean; reserve?: number }
): Promise<T> {
  const token = await ensureValidToken();
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  let encodedBody: URLSearchParams | undefined;
  if (body instanceof URLSearchParams) {
    encodedBody = body;
  } else if (body) {
    encodedBody = new URLSearchParams(body);
  }

  return withHttpSlot(async () => {
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "inoreader-mcp/0.1.0",
      },
      body: encodedBody,
    },
    `POST ${path}`, ZONE1_POST_PATHS.has(path) ? 1 : 2, options?.reserve
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Inoreader API error ${res.status} on POST ${path}: ${text.slice(0, 2000)}${ZONE1_POST_PATHS.has(path) ? "" : ". Not replayed; read back before further writes if the outcome is uncertain."}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && !options?.expectOk) {
    return res.json() as Promise<T>;
  }

  const text = await res.text();
  // Inoreader answers an applied edit with the literal body "OK" (verified against
  // subscription/edit: 200, text/html, body exactly "OK"). A 2xx carrying anything
  // else means the request was accepted but not necessarily applied. Throw, then
  // read back before considering reconciliation; never blindly replay it.
  //
  // This is a cheap first filter, NOT a guarantee. Inoreader has been observed
  // returning 200 while applying only half of a combined add+remove edit, which is
  // why the bulk tools verify by reading state back regardless of what this says.
  // Opt-in per call site: quickadd and stream/items/contents return other shapes.
  if (options?.expectOk && text.trim() !== "OK") {
    throw new Error(
      `Inoreader returned ${res.status} on POST ${path} with unexpected body: ${text.slice(0, 200)}`
    );
  }
  return text as unknown as T;
  });
}
