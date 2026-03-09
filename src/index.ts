#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { getAuthUrl, exchangeCode, isAuthenticated } from "./auth.js";
import { registerReadingTools } from "./tools/reading.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerOrganizationTools } from "./tools/organization.js";
import { registerAnalyticsTools } from "./tools/analytics.js";

const server = new McpServer({
  name: "inoreader-mcp",
  version: "0.1.0",
});

// Auth setup tool - always available
server.tool(
  "setup_auth",
  "Authenticate with Inoreader via OAuth 2.0. If no code is provided, returns the authorization URL to visit. If a code is provided, exchanges it for access tokens.",
  {
    code: z
      .string()
      .optional()
      .describe(
        "Authorization code from the OAuth callback URL (the 'code' query parameter)"
      ),
  },
  async (params) => {
    if (!params.code) {
      const url = getAuthUrl();
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "To authenticate with Inoreader:",
              "",
              "1. Open this URL in your browser:",
              url,
              "",
              "2. Authorize the application",
              "3. Copy the 'code' parameter from the redirect URL",
              "4. Call this tool again with the code parameter",
            ].join("\n"),
          },
        ],
      };
    }

    await exchangeCode(params.code);
    return {
      content: [
        {
          type: "text" as const,
          text: "Authentication successful! Tokens saved. You can now use all Inoreader tools.",
        },
      ],
    };
  }
);

// Register all tool groups
registerReadingTools(server);
registerSubscriptionTools(server);
registerOrganizationTools(server);
registerAnalyticsTools(server);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);

if (!isAuthenticated()) {
  process.stderr.write(
    "[inoreader-mcp] Not authenticated. Use the setup_auth tool to connect your Inoreader account.\n"
  );
}

process.stderr.write("[inoreader-mcp] Server started\n");
