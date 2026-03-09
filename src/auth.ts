import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

function saveTokens(tokens: TokenData): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

let cachedTokens: TokenData | null = null;

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

  // Refresh if token expires within 60 seconds
  if (Date.now() > cachedTokens.expires_at - 60_000) {
    cachedTokens = await refreshAccessToken(cachedTokens.refresh_token);
  }

  return cachedTokens.access_token;
}

export function isAuthenticated(): boolean {
  if (!cachedTokens) {
    cachedTokens = loadTokens();
  }
  return cachedTokens !== null;
}
