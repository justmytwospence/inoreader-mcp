import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { exchangeCode, getAuthUrl, hasCallbackReceiver } from "./auth.js";
import { registerReadingTools } from "./tools/reading.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerOrganizationTools } from "./tools/organization.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerCalibrationTools } from "./tools/calibration.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "inoreader-mcp";
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

function registerSetupAuth(server: McpServer): void {
  server.registerTool(
    "setup_auth",
    {
      description:
        "Authenticate with Inoreader via OAuth 2.0. If no code is provided, returns the authorization URL to visit. If a code is provided, exchanges it for access tokens.",
      inputSchema: z.object({
        code: z
          .string()
          .optional()
          .describe("Authorization code from the OAuth callback URL (the 'code' query parameter)"),
      }),
    },
    async (params) => {
      if (!params.code) {
        const steps = hasCallbackReceiver()
          ? [
              "2. Authorize the application",
              "3. The page you land on saves the tokens; there is nothing to paste back",
            ]
          : [
              "2. Authorize the application",
              "3. Copy the 'code' parameter from the redirect URL",
              "4. Call this tool again with the code parameter",
            ];
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "To authenticate with Inoreader:",
                "",
                "1. Open this URL in your browser:",
                getAuthUrl(),
                "",
                ...steps,
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
}

/**
 * Builds a fully registered server. The HTTP transport calls this once per request,
 * stdio once per process, so keep it free of side effects and I/O. Tokens, the rate
 * limiter and caches live at module scope.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerSetupAuth(server);
  registerReadingTools(server);
  registerSubscriptionTools(server);
  registerOrganizationTools(server);
  registerAnalyticsTools(server);
  registerCalibrationTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}
