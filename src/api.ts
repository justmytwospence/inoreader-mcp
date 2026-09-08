import { ensureValidToken } from "./auth.js";
import { getCached, setCached, invalidate } from "./cache.js";
import { noteRequest, updateFromHeaders } from "./rate-limit.js";

const BASE_URL = "https://www.inoreader.com";

export { invalidate as invalidateCache };

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
  const secs = Number.parseInt(raw, 10);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Full jitter, so a batch that trips a limit does not retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(RETRY.maxMs, RETRY.baseMs * 2 ** attempt);
}

/**
 * One fetch with timeout, honouring 429/Retry-After and retrying 5xx and transport
 * failures with jittered backoff.
 *
 * Retrying a POST is safe here because Inoreader's edit endpoints are idempotent set
 * operations: adding a label a feed already carries, removing one it does not, or
 * subscribing to a feed already subscribed are all no-ops. Do not extend this to an
 * endpoint where that stops being true.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY.maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!isRetryableStatus(res.status) || attempt === RETRY.maxAttempts - 1) return res;

      const wait = retryAfterMs(res);
      if (wait !== null) {
        // Being told to wait longer than we are willing to sleep is information the
        // caller needs, not something to silently absorb.
        if (wait > RETRY.ceilingMs) {
          throw new Error(
            `Inoreader asked us to back off ${Math.round(wait / 1000)}s on ${label} ` +
              `(${res.status}); giving up rather than blocking the tool call.`
          );
        }
        await sleep(wait);
      }
    } catch (e) {
      // A thrown backoff-ceiling error is a decision, not a transport failure.
      if (e instanceof Error && e.message.includes("asked us to back off")) throw e;
      lastError = e;
      if (attempt === RETRY.maxAttempts - 1) break;
    }
  }
  throw new Error(
    `Inoreader request failed on ${label} after ${RETRY.maxAttempts} attempts: ` +
      (lastError instanceof Error ? lastError.message : String(lastError))
  );
}

export async function apiGet<T>(path: string, params?: Record<string, string | string[]>): Promise<T> {
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

  const cacheKey = url.toString();
  const cached = getCached<T>(cacheKey);
  if (cached !== null) return cached;

  const token = await ensureValidToken();
  noteRequest(1);
  const res = await fetchWithRetry(
    cacheKey,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "inoreader-mcp/0.1.0",
      },
    },
    `GET ${path}`
  );

  updateFromHeaders(res.headers);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Inoreader API error ${res.status} on GET ${path}: ${text}`);
  }

  const data = await res.json() as T;
  setCached(cacheKey, data);
  return data;
}

export async function apiPost<T>(
  path: string,
  body?: Record<string, string> | URLSearchParams,
  params?: Record<string, string>,
  options?: { expectOk?: boolean }
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

  noteRequest(ZONE1_POST_PATHS.has(path) ? 1 : 2);
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
    `POST ${path}`
  );

  updateFromHeaders(res.headers);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Inoreader API error ${res.status} on POST ${path}: ${text}`);
  }

  // Writes may change server state, so invalidate all cached reads
  invalidate();

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json() as Promise<T>;
  }

  const text = await res.text();
  // Inoreader answers an applied edit with the literal body "OK" (verified against
  // subscription/edit: 200, text/html, body exactly "OK"). A 2xx carrying anything
  // else means the request was accepted but not necessarily applied, so throw and
  // let the caller's retry path run rather than bank a phantom success.
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
}
