import { ensureValidToken } from "./auth.js";
import { getCached, setCached, invalidate } from "./cache.js";
import { updateFromHeaders } from "./rate-limit.js";

const BASE_URL = "https://www.inoreader.com";

/**
 * Apply query params to a URL. Array values are appended as repeated keys,
 * which is what Inoreader requires for multi-value params such as `xt`.
 * Using searchParams.set() with an array would coerce it to a single
 * comma-joined value and the filter would silently not apply.
 */
function applyParams(url: URL, params: QueryParams): void {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== "") url.searchParams.append(k, item);
      }
    } else if (v !== "") {
      url.searchParams.set(k, v);
    }
  }
}

export { invalidate as invalidateCache };

export type QueryParams = Record<string, string | string[] | undefined>;

export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) applyParams(url, params);

  const cacheKey = url.toString();
  const cached = getCached<T>(cacheKey);
  if (cached !== null) return cached;

  const token = await ensureValidToken();
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
  params?: QueryParams
): Promise<T> {
  const token = await ensureValidToken();
  const url = new URL(path, BASE_URL);
  if (params) applyParams(url, params);

  let encodedBody: URLSearchParams | undefined;
  if (body instanceof URLSearchParams) {
    encodedBody = body;
  } else if (body) {
    encodedBody = new URLSearchParams(body);
  }

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
  return (await res.text()) as unknown as T;
}
