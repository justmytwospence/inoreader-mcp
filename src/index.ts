#!/usr/bin/env node

// Entry point: serve createServer() over stdio (default, for local clients that spawn
// the process) or Streamable HTTP (MCP_TRANSPORT=http, for running as a service).
// All of the protocol handling is the MCP SDK's; this file only picks a transport.

import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Context } from "hono";
import { isAuthenticated } from "./auth.js";
import { registerOAuthCallback, startKeepalive } from "./keepalive.js";
import { createServer, SERVER_NAME, VERSION } from "./server.js";

const missing = ["INOREADER_CLIENT_ID", "INOREADER_CLIENT_SECRET"].filter((v) => !process.env[v]);
if (missing.length) {
  console.error(
    `ERROR: missing required environment variable(s): ${missing.join(", ")}.\n` +
      "Register an app at https://www.inoreader.com/developers/register-app.",
  );
  process.exit(1);
}

const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "stdio") {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} ${VERSION} running via stdio`);
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 8000);
  // Hostnames clients may use in the Host header (DNS-rebinding protection). Unset
  // means any host, which is fine on a private network or behind a reverse proxy.
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = extraHosts.length ? ["localhost", "127.0.0.1", ...extraHosts] : undefined;

  const handler = createMcpHandler(createServer);
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts });
  app.get("/health", (c) => c.json({ status: "ok", name: SERVER_NAME, version: VERSION }));
  const mcp = (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  app.all("/mcp", mcp);
  app.all("/", mcp);
  registerOAuthCallback(app);
  startKeepalive();

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) =>
    console.error(`${SERVER_NAME} ${VERSION} listening on http://0.0.0.0:${info.port}/mcp`),
  );
  const shutdown = async () => {
    await handler.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error(`ERROR: MCP_TRANSPORT must be "stdio" or "http", got "${transport}".`);
  process.exit(1);
}

if (!isAuthenticated()) {
  console.error(
    "[inoreader-mcp] Not authenticated. Use the setup_auth tool to connect your Inoreader account.",
  );
}
