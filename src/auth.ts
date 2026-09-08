import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TokenData } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "inoreader-mcp");
const TOKEN_PATH = join(CONFIG_DIR, "tokens.json");

const AUTH_URL = "https://www.inoreader.com/oauth2/auth";
const TOKEN_URL = "https://www.inoreader.com/oauth2/token";

function getClientId(): string {
  const id = process.env.INOREADER_CLIENT_ID;
  if (!id) throw new Error("INOREADER_CLIENT_ID environment variable is required");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.INOREADER_CLIENT_SECRET;
  if (!secret) throw new Error("INOREADER_CLIENT_SECRET environment variable is required");
  return secret;
}

function getRedirectUri(): string {
  return process.env.INOREADER_REDIRECT_URI ?? "http://localhost:3333/callback";
}

function loadTokens(): TokenData | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    if (data.access_token && data.refresh_token && data.expires_at) {
      return data as TokenData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the token file atomically at 0600.
 *
 * Two bugs fixed here. The plain writeFileSync used the default 0644 mask, so the
 * first refresh from this process silently widened a file the oauth-callback
 * container had deliberately created 0600 -- a credential readable by every user on
 * the box. And a non-atomic write can be read half-finished: that container refreshes
 * the same file on a timer, so a torn read is a real interleaving, not a theoretical
 * one.
 *
 * The temp name carries pid + uuid because oauth-callback/app.py stages its own write
 * at a FIXED `${TOKEN_PATH}.tmp`; sharing that name would let the two clobber each
 * other mid-write. Same-directory rename is atomic on ext4.
 */
function saveTokens(tokens: TokenData): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${TOKEN_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, TOKEN_PATH);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing staged */
    }
    throw e;
  }
}

let cachedTokens: TokenData | null = null;

/**
 * In-flight refresh dedup.
 *
 * Without this, concurrent requests near expiry each POST to the token endpoint.
 * Inoreader rotates the refresh token on use, so the later responses invalidate the
 * earlier ones and whichever writes last wins -- a lost rotation means a browser
 * re-auth. Write concurrency is 1 now, but reads still run in parallel.
 */
let refreshInFlight: Promise<TokenData> | null = null;

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "read write",
    state: "inoreader-mcp",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<TokenData> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const tokens: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  cachedTokens = tokens;
  return tokens;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const tokens: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  cachedTokens = tokens;
  return tokens;
}

export async function ensureValidToken(): Promise<string> {
  if (!cachedTokens) {
    cachedTokens = loadTokens();
  }

  if (!cachedTokens) {
    throw new Error(
      "Not authenticated. Use the setup_auth tool to authenticate with Inoreader."
    );
  }

  // Refresh if the token expires within 60 seconds.
  if (Date.now() > cachedTokens.expires_at - 60_000) {
    // Dedup within this process: the first caller does the work, the rest await it.
    refreshInFlight ??= (async () => {
      // Re-read from disk before spending the refresh token. The oauth-callback
      // container refreshes this file on a 12h timer and another MCP process may
      // have just rotated it -- adopting a token that is already valid turns the
      // common cross-process race into a no-op instead of a rotation that
      // invalidates somebody else's.
      const onDisk = loadTokens();
      if (onDisk && Date.now() < onDisk.expires_at - 300_000) {
        cachedTokens = onDisk;
        return onDisk;
      }
      const current = onDisk ?? cachedTokens!;
      // Deliberately noisy: the keepalive runs 12h against a 24h token, so this
      // path should essentially never fire. If it does, the assumption has broken
      // and stderr is the only place that would show it.
      console.error("[inoreader-mcp] refreshing access token from the MCP process");
      return await refreshAccessToken(current.refresh_token);
    })().finally(() => {
      refreshInFlight = null;
    });

    cachedTokens = await refreshInFlight;
  }

  return cachedTokens.access_token;
}

export function isAuthenticated(): boolean {
  if (!cachedTokens) {
    cachedTokens = loadTokens();
  }
  return cachedTokens !== null;
}
