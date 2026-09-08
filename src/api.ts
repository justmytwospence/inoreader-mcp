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
  const res = await fetch(cacheKey, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "inoreader-mcp/0.1.0",
    },
  });

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
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "inoreader-mcp/0.1.0",
    },
    body: encodedBody,
  });

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
