import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent, setAgentCapabilities } from "../../lib/agents";
import { createWorkspace, applyPatch } from "../../lib/workspaces";
import { handleMcpMessage, MCP_PROTOCOL_VERSION } from "../../lib/mcp";
import type { Agent } from "../../lib/types";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});
after(() => {
  Date.now = RealDateNow;
  _resetDbForTests();
  teardownTestDb();
});
beforeEach(() => {
  resetTables(db());
  NOW = 1_700_000_000_000;
});

function seedAgent(userId: string, handle: string): Agent {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

// Cast helper for reading the JSON-RPC result payload in assertions.
function result(resp: unknown): Record<string, unknown> {
  const r = resp as { result?: Record<string, unknown> };
  assert.ok(r.result, "expected a JSON-RPC result");
  return r.result;
}

describe("MCP — initialize", () => {
  it("returns the protocol version, tools capability, and serverInfo", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = await handleMcpMessage(a, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const res = result(resp);
    assert.equal(res.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
    assert.equal((res.serverInfo as { name: string }).name, "agent2agent");
  });
});

describe("MCP — tools/list", () => {
  it("lists every tool with an inputSchema (JSON Schema)", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = await handleMcpMessage(a, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = result(resp).tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    assert.ok(Array.isArray(tools) && tools.length > 0);
    const listFiles = tools.find((t) => t.name === "workspace.list_files");
    assert.ok(listFiles, "workspace.list_files should be listed");
    assert.equal((listFiles.inputSchema as { type: string }).type, "object");
    assert.ok(typeof listFiles.description === "string" && listFiles.description.length > 0);
  });
});

describe("MCP — tools/call", () => {
  it("runs a tool the agent is allowed to call and returns text content", async () => {
    const a = seedAgent("usr_a", "alpha");
    setAgentCapabilities(a.id, "usr_a", [
      { name: "workspace.read", version: "1" },
      { name: "workspace.write", version: "1" },
    ]);
    const ws = createWorkspace({ name: "w", conversation_id: null, created_by_agent_id: a.id });
    const patch = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "hello" }],
    });
    if (!patch.ok) return assert.fail("seed patch failed");

    const resp = await handleMcpMessage(getAgent(a.id)!, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workspace.read_file", arguments: { workspace_id: ws.id, path: "a.txt" } },
    });
    const res = result(resp);
    assert.equal(res.isError, false);
    const content = res.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /hello/);
  });

  it("reports a capability denial IN-BAND (isError:true), not as a JSON-RPC error", async () => {
    const a = seedAgent("usr_a", "alpha"); // no capabilities
    const resp = await handleMcpMessage(a, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace.read_file", arguments: { workspace_id: "wks_x", path: "a.txt" } },
    });
    const res = result(resp);
    assert.equal(res.isError, true);
    const content = res.content as Array<{ text: string }>;
    assert.match(content[0].text, /capability/);
  });

  it("returns -32602 when the tool name is missing", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = (await handleMcpMessage(a, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {},
    })) as { error?: { code: number } };
    assert.equal(resp.error?.code, -32602);
  });
});

describe("MCP — protocol conformance", () => {
  it("answers ping with an empty result", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = await handleMcpMessage(a, { jsonrpc: "2.0", id: 6, method: "ping" });
    assert.deepEqual(result(resp), {});
  });

  it("treats notifications/initialized as a notification (no response)", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = await handleMcpMessage(a, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(resp, null);
  });

  it("returns -32601 for an unknown method", async () => {
    const a = seedAgent("usr_a", "alpha");
    const resp = (await handleMcpMessage(a, {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    })) as { error?: { code: number } };
    assert.equal(resp.error?.code, -32601);
  });
});
