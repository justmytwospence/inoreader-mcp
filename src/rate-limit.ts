import type { RateLimitState } from "./types.js";

const state: RateLimitState = {
  zone1: { limit: 0, usage: 0, resetAfterSec: 0, lastUpdated: 0 },
  zone2: { limit: 0, usage: 0, resetAfterSec: 0, lastUpdated: 0 },
};

export function updateFromHeaders(headers: Headers): void {
  const zone1Limit = headers.get("x-reader-limits-zone1");
  const zone1Usage = headers.get("x-reader-zone1-usage");
  const zone2Limit = headers.get("x-reader-limits-zone2");
  const zone2Usage = headers.get("x-reader-zone2-usage");
  const resetAfter = headers.get("x-reader-limits-reset-after");

  const now = Date.now();

  if (zone1Limit) state.zone1.limit = parseInt(zone1Limit, 10);
  if (zone1Usage) state.zone1.usage = parseInt(zone1Usage, 10);
  if (zone2Limit) state.zone2.limit = parseInt(zone2Limit, 10);
  if (zone2Usage) state.zone2.usage = parseInt(zone2Usage, 10);
  if (resetAfter) {
    const sec = parseInt(resetAfter, 10);
    state.zone1.resetAfterSec = sec;
    state.zone2.resetAfterSec = sec;
  }

  state.zone1.lastUpdated = now;
  state.zone2.lastUpdated = now;
}

export function getState(): RateLimitState {
  return structuredClone(state);
}
