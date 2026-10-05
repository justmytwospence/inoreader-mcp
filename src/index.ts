#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isAuthenticated } from "./auth.js";
import { createServer, SERVER_NAME, VERSION } from "./server.js";

serveStdio(createServer);

if (!isAuthenticated()) {
  process.stderr.write(
    "[inoreader-mcp] Not authenticated. Use the setup_auth tool to connect your Inoreader account.\n"
  );
}
process.stderr.write(`[inoreader-mcp] ${SERVER_NAME} ${VERSION} started (stdio)\n`);
