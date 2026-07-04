import "server-only";
import { invokeTool, listToolsForAgent } from "./tools";
import type { Agent } from "./types";

// ---------------------------------------------------------------------------
// Model Context Protocol (MCP) server — agent↔tools socket.
//
// MCP (Anthropic, now an Agentic AI Foundation project) is the agent-to-TOOLS
// layer; A2A is the agent-to-AGENT layer. Per the 2026 two-layer consensus
// (see PROTOCOL_LANDSCAPE_2026), we already speak A2A on the hub — this exposes
// the hub's existing TOOLS registry as a standard MCP server so a user's own
// runtime (Claude Code, Cursor, any MCP client) can discover and call our
// capabilities as native MCP tools. Zero new deps: hand-rolled JSON-RPC over
// the Streamable-HTTP transport.
//
// Scope: a tools-only server (no resources/prompts). The client authenticates
// with an agent api key (Bearer) exactly like the REST API; tool calls run in
// that agent's context and are capability-gated by invokeTool.
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "agent2agent";
const SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;

export type McpMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResult = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };
type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};
export type JsonRpcResponse = JsonRpcResult | JsonRpcError;

function ok(id: JsonRpcId, result: unknown): JsonRpcResult {
  return { jsonrpc: "2.0", id, result };
}
function err(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** True for a JSON-RPC notification (no `id` member) — these get no response. */
function isNotification(msg: McpMessage): boolean {
  return !("id" in msg) || msg.id === undefined;
}

/** Handle one MCP JSON-RPC message for `agent`. Returns the response object,
 *  or null for notifications (the transport should reply 202 with no body). */
export async function handleMcpMessage(
  agent: Agent,
  msg: McpMessage,
): Promise<JsonRpcResponse | null> {
  const id = (msg.id ?? null) as JsonRpcId;
  const method = msg.method;
  const notification = isNotification(msg);

  if (typeof method !== "string") {
    return notification ? null : err(id, -32600, "Invalid Request: missing method.");
  }

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Agent2Agent tools socket. Call tools/list to see workspace, task, " +
          "and messaging tools; tools/call runs them in your agent's context " +
          "(capability-gated). Set capabilities via PUT /api/v1/agents/me/capabilities.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications — no response

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const tools = listToolsForAgent(agent).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.schema,
      }));
      return ok(id, { tools });
    }

    case "tools/call": {
      const params = msg.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!name) return err(id, -32602, "Invalid params: tool name is required.");
      const res = await invokeTool(agent.id, name, args, null);
      if (res.ok) {
        // MCP tool results carry content blocks; JSON payloads go as text.
        return ok(id, {
          content: [{ type: "text", text: stringifyResult(res.result) }],
          isError: false,
        });
      }
      // Tool-execution errors are reported IN-BAND (isError:true) — not as a
      // JSON-RPC error — so the calling model can read and react to them.
      return ok(id, {
        content: [{ type: "text", text: res.error }],
        isError: true,
      });
    }

    default:
      return notification ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
