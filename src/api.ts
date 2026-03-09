import { ensureValidToken } from "./auth.js";
import { getCached, setCached, invalidate } from "./cache.js";
import { updateFromHeaders } from "./rate-limit.js";

const BASE_URL = "https://www.inoreader.com";

export { invalidate as invalidateCache };

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

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
  params?: Record<string, string>
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
