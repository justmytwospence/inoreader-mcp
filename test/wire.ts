import { createServer } from "../src/server.js";

/** Real SDK JSON-RPC dispatch on an in-memory transport, no client dependency. */
export async function connect() {
  const server = createServer();
  type Transport = Parameters<typeof server.connect>[0];
  const pending = new Map<number, (value: any) => void>();
  const transport: Transport = {
    async start() {}, async close() {},
    async send(message) {
      if ("id" in message && typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    },
  };
  await server.connect(transport);
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
    pending.set(current, (response) => {
      clearTimeout(timer);
      if (response.error) reject(new Error(JSON.stringify(response.error)));
      else resolve(response.result);
    });
    transport.onmessage?.({ jsonrpc: "2.0", id: current, method, params });
  });
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
  });
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, request, initialized };
}
