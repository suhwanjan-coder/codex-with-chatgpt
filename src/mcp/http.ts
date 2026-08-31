import type { Request, Response } from "express";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger/index.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ReviewSession } from "../review/session.js";
import { REVIEW_PROTOCOL_LIMITS } from "../review/snapshot.js";

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST.
 * This maximizes compatibility with remote MCP clients (including ChatGPT)
 * and avoids cross-request session state on a public endpoint.
 */
export function createMcpHttpHandler(makeServer: () => McpServer, logger: Logger, review?: ReviewSession, options: { readOnly?: boolean } = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams, no sessions to delete.
      const payload = {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      };
      const bytes = req.method === "HEAD" ? 0 : Buffer.byteLength(JSON.stringify(payload));
      if (review && !review.accountProtocol(bytes)) res.status(204).end();
      else res.status(405).json(payload);
      return;
    }
    // Count rejected tool calls too. SDK schema rejection happens before tool callbacks.
    if (review && (Array.isArray(req.body) || req.body?.method === "tools/call")) {
      const body = req.body;
      const validId = (typeof body.id === "string" && Buffer.byteLength(body.id) <= 128) || (typeof body.id === "number" && Number.isFinite(body.id));
      const validEnvelope = !Array.isArray(body) && body.jsonrpc === "2.0" && validId;
      const name = validEnvelope && typeof body.params?.name === "string" ? body.params.name : "";
      const scopes = (req as Request & { auth?: AuthInfo }).auth?.scopes ?? [];
      const args = body.params && Object.hasOwn(body.params, "arguments") ? body.params.arguments : {};
      const envelope = (result: unknown): unknown => ({ jsonrpc: "2.0", id: validId ? body.id : null, ...(validEnvelope ? { result } : { error: { code: -32600, message: "Invalid request" } }) });
      // Hiding a tool from discovery must also reject a hand-crafted invocation.
      const allowedName = options.readOnly && name === "review_complete" ? "remote_completion_disabled" : name;
      const result = review.invoke(allowedName, args, scopes, envelope);
      if (review.suppressResponse) res.status(204).end();
      else res.json(envelope(result));
      return;
    }
    const server = makeServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new globalThis.Request(`http://${req.get("host")}/mcp`, {
        method: req.method, headers, body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
      });
      const response = await transport.handleRequest(request, { parsedBody: req.body, authInfo: (req as Request & { auth?: AuthInfo }).auth });
      // Buffer the bounded SDK protocol response before sending any body bytes.
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > REVIEW_PROTOCOL_LIMITS.maxResponseBytes) { await reader.cancel(); break; }
          chunks.push(next.value);
        }
      }
      if ((review && !review.accountProtocol(bytes)) || bytes > REVIEW_PROTOCOL_LIMITS.maxResponseBytes) {
        res.status(204).end(); return;
      }
      response.headers.forEach((value, key) => { if (key !== "content-length" && key !== "transfer-encoding") res.set(key, value); });
      res.status(response.status).end(Buffer.concat(chunks));
    } catch (error) {
      logger.error("MCP request handling failed");
      if (review) { review.close(); if (!res.headersSent) res.status(204).end(); return; }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
