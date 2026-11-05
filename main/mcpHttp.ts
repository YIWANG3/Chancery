// Serves the steward MCP over streamable HTTP on localhost, stateless: one server + transport per request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createChanceryMcpServer, type McpDeps } from "../core/mcp.js";

export function startMcpHttp(deps: McpDeps, port: number, log: (m: string) => void): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mcp: "/mcp" }));
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req);
    const server = createChanceryMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal" }));
    }
  };
  const http = createServer((req, res) => void handle(req, res));
  http.listen(port, "127.0.0.1", () => log(`mcp listening on http://127.0.0.1:${port}/mcp`));
  http.on("error", (err) => log(`mcp http error: ${err.message}`));
  return http;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
