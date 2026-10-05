import type { Hono } from "hono";
import { exchangeCode, refreshStoredTokens } from "./auth.js";

// HTTP-mode extras. A long-running server can do two things a stdio process spawned per
// call never could: receive the OAuth redirect itself, and keep the grant alive.

const EXPECTED_STATE = "inoreader-mcp"; // what getAuthUrl() sends

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, detail: string): string {
  return (
    "<!doctype html><meta charset=utf-8><title>Inoreader MCP</title>" +
    "<style>body{font:16px system-ui;margin:4rem auto;max-width:34rem;padding:0 1rem}</style>" +
    `<h1>${escapeHtml(title)}</h1><p>${detail}</p>`
  );
}

/**
 * GET /callback: the OAuth redirect target. Point INOREADER_REDIRECT_URI (and the
 * redirect URI registered on your Inoreader app) at https://<this server>/callback and
 * setup_auth becomes one click: authorize, land here, done.
 */
export function registerOAuthCallback(app: Hono<any>): void {
  app.get("/callback", async (c) => {
    const { code, state, error, error_description } = c.req.query();
    if (error) {
      return c.html(
        page("Authorization failed", escapeHtml(`${error}: ${error_description ?? ""}`)),
        400,
      );
    }
    if (state !== EXPECTED_STATE) {
      return c.html(page("Bad request", "Unexpected or missing <code>state</code>."), 400);
    }
    if (!code) return c.html(page("Bad request", "Missing <code>code</code>."), 400);
    try {
      await exchangeCode(code);
    } catch (e) {
      console.error("[inoreader-mcp] callback: token exchange failed:", e);
      return c.html(page("Token exchange failed", escapeHtml(String(e))), 502);
    }
    console.error("[inoreader-mcp] callback: saved new tokens");
    return c.html(page("Inoreader connected", "Tokens saved. You can close this tab."));
  });
}

/** Best-effort ntfy push (NTFY_URL + NTFY_TOPIC, optional NTFY_TOKEN). */
async function notify(title: string, message: string): Promise<void> {
  const { NTFY_URL, NTFY_TOPIC, NTFY_TOKEN } = process.env;
  if (!NTFY_URL || !NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_URL.replace(/\/$/, "")}/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: {
        Title: title,
        Priority: "high",
        Tags: "warning",
        ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[inoreader-mcp] ntfy notify failed:", e);
  }
}

/**
 * Refresh the grant every INOREADER_KEEPALIVE_HOURS (default 12, 0 disables). Against a
 * 24h access token this also means the lazy refresh in ensureValidToken() never races it.
 */
export function startKeepalive(): void {
  const hours = Number(process.env.INOREADER_KEEPALIVE_HOURS ?? 12);
  if (!(hours > 0)) return;
  const tick = async () => {
    try {
      if (await refreshStoredTokens()) console.error("[inoreader-mcp] keepalive: refreshed tokens");
      else console.error("[inoreader-mcp] keepalive: not authenticated yet, skipping");
    } catch (e) {
      console.error("[inoreader-mcp] keepalive: refresh failed:", e);
      await notify(
        "Inoreader token refresh failed",
        `${e}\n\nRe-authorize with the setup_auth tool -- the server is unauthenticated until you do.`,
      );
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(tick, hours * 3_600_000);
  }, 60_000);
}
