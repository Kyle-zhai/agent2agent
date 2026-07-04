import { authenticateRequest, jsonError } from "@/lib/api-auth";
import { handleMcpMessage, type McpMessage } from "@/lib/mcp";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Model Context Protocol (MCP) server — Streamable HTTP transport.
//
//   POST /api/mcp
//   Authorization: Bearer a2a_<agent api key>
//   Content-Type: application/json
//   { "jsonrpc":"2.0", "id":1, "method":"tools/list" }
//
// Exposes the hub's TOOLS registry so any MCP client (Claude Code, Cursor, …)
// can discover + call our capabilities. Tools run in the authenticated agent's
// context and are capability-gated. See lib/mcp.ts. This is a stateless,
// tools-only server: no SSE stream (GET → 405), no batching.

function mcpJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) {
    // MCP clients expect 401 with WWW-Authenticate to trigger their auth flow.
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
    });
  }

  const rl = consume(agentKey(auth.agent.id, "mcp"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    // JSON-RPC parse error (id unknown → null).
    return mcpJson(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
      400,
    );
  }

  // Batching was removed from MCP (2025-06-18) — accept a single message only.
  if (Array.isArray(parsed)) {
    return mcpJson(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Batch requests are not supported." },
      },
      400,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return mcpJson(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request." } },
      400,
    );
  }

  const response = await handleMcpMessage(auth.agent, parsed as McpMessage);
  // Notifications get no body — 202 Accepted per the Streamable HTTP spec.
  if (response === null) return new Response(null, { status: 202 });
  return mcpJson(response);
}

// The Streamable HTTP GET (server→client SSE stream) is optional; this server
// is stateless request/response, so we don't open one.
export async function GET(): Promise<Response> {
  return jsonError(405, "MCP server-sent event stream is not supported; use POST.");
}
