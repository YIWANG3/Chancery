// Serves the steward MCP over streamable HTTP on localhost, stateless: one server + transport per request.
// Only for this machine: the socket listens on 127.0.0.1 and every request is checked to have come by that name.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createChanceryMcpServer, type McpDeps } from "../core/mcp.js";

const LOCAL = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Whether a request was addressed to this machine by its own name, by something on this machine. The tools hand out
 * what was said in the person's sessions, so a web page must not be able to reach them: one that points its own
 * domain at 127.0.0.1 arrives with that domain as Host, and anything a browser sends cross-site carries an Origin.
 */
export function isLocalRequest(headers: { host?: string; origin?: string }): boolean {
  const host = (headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOCAL.includes(host)) return false;
  if (!headers.origin) return true;
  try {
    return LOCAL.includes(new URL(headers.origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function startMcpHttp(deps: McpDeps, port: number, log: (m: string) => void): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalRequest(req.headers)) {
      res.writeHead(403).end();
      return;
    }
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
