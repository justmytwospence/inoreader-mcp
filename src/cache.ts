// INERT UNDER THE CURRENT DEPLOYMENT. This is a module-level Map in a process that
// mcpjungle spawns fresh for every tool call, so it is empty on arrival and discarded
// moments later -- getCached has never returned a hit in that setup. It is kept
// because a long-lived host process (npx inoreader-mcp over a persistent stdio
// session) does benefit, but no tool description may claim caching or a zero-cost
// repeat read; those claims were wrong for months and made the model under-count its
// real Zone 1 usage.
//
// If this is ever made to persist across processes, note that verify.ts MUST bypass
// it: a cache that can serve stale state to the read-back check would defeat the one
// mechanism establishing ground truth.
const DEFAULT_TTL_MS = Infinity; // no expiry; cleared on analyze_feeds refresh or any write

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCached<T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function invalidate(keyPrefix?: string): void {
  if (!keyPrefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.includes(keyPrefix)) {
      cache.delete(key);
    }
  }
}
