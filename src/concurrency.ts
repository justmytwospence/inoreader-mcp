/** Shared per-process admission across API calls and public-site discovery.
 * Slots cover the response body, not just the arrival of response headers.
 */
export const MAX_HTTP_CONCURRENCY = 4;
let active = 0;
const waiters: Array<() => void> = [];

export async function withHttpSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_HTTP_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
  else active++;
  try {
    return await run();
  } finally {
    const next = waiters.shift();
    if (next) next(); // transfer the slot without opening a race for new callers
    else active--;
  }
}
