import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import {
  _drainPendingForTests,
  cancelCall,
  dispatchToolCall,
  findHostsForTool,
  getCall,
  listPendingForAgent,
  markCallsDelivered,
  reportToolResult,
} from "../../lib/reverse-rpc";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});

after(() => {
  Date.now = RealDateNow;
  _drainPendingForTests();
  _resetDbForTests();
  teardownTestDb();
});

beforeEach(() => {
  _drainPendingForTests();
  resetTables(db());
});

function seedAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
}

function befriend(a: string, b: string) {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

describe("findHostsForTool", () => {
  it("returns agents with matching mcp.host capability", () => {
    const a = seedAgent("usr_a", "alpha");
    const b = seedAgent("usr_b", "bravo");
    setAgentCapabilities(a.id, "usr_a", [
      { name: "mcp.host", tools: ["fs.read", "fs.write"] },
    ]);
    setAgentCapabilities(b.id, "usr_b", [
      { name: "mcp.host", tools: ["github.search"] },
    ]);
    const hosts = findHostsForTool("fs.read").map((x) => x.id);
    assert.deepEqual(hosts, [a.id]);
    const ghHosts = findHostsForTool("github.search").map((x) => x.id);
    assert.deepEqual(ghHosts, [b.id]);
    assert.equal(findHostsForTool("nonexistent").length, 0);
  });
});

describe("dispatchToolCall round-trip", () => {
  it("creates a pending row + agent posts ok → caller resolves with result", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);

    const promise = dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: { path: "/tmp/x" },
    });
    // Find the pending row + simulate the agent reporting back
    const pending = listPendingForAgent(host.id);
    assert.equal(pending.length, 1);
    const rpcId = pending[0].id;
    reportToolResult({
      rpc_id: rpcId,
      reporter_agent_id: host.id,
      ok: true,
      result: { content: "hello" },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.result, { content: "hello" });
    assert.equal(getCall(rpcId)!.status, "completed");
  });

  it("agent posts fail → caller resolves with reason", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);
    const promise = dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: {},
    });
    const rpcId = listPendingForAgent(host.id)[0].id;
    reportToolResult({
      rpc_id: rpcId,
      reporter_agent_id: host.id,
      ok: false,
      error: "permission denied",
    });
    const res = await promise;
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, "failed");
    assert.ok(res.reason.includes("permission denied"));
  });

  it("rejects dispatch when caller is not a friend of any host", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    // no befriend
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);
    const res = await dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: {},
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.reason.includes("reachable"));
  });

  it("rejects dispatch when no host declares the tool", async () => {
    const caller = seedAgent("usr_c", "caller");
    const res = await dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "ghost.tool",
      args: {},
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.reason.includes("no agent hosts"));
  });

  it("times out when host never reports", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["slow.tool"] },
    ]);
    const res = await dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "slow.tool",
      args: {},
      timeout_ms: 1000,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, "timeout");
    const row = getCall(listPendingForAgent(host.id, 50).at(-1)?.id ?? "");
    // The pending list is filtered to status=pending, so after timeout it's empty.
    void row;
  });

  it("rejects reportToolResult from a non-target agent", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    const stranger = seedAgent("usr_x", "stranger");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);
    const promise = dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: {},
      timeout_ms: 1000,
    });
    const rpcId = listPendingForAgent(host.id)[0].id;
    assert.throws(
      () =>
        reportToolResult({
          rpc_id: rpcId,
          reporter_agent_id: stranger.id,
          ok: true,
        }),
      /not the target/,
    );
    // Resolve via timeout so the awaited promise unblocks.
    await promise;
  });
});

describe("cancelCall", () => {
  it("caller can cancel; resolves with cancelled status", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);
    const promise = dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: {},
      timeout_ms: 30_000,
    });
    const rpcId = listPendingForAgent(host.id)[0].id;
    cancelCall(rpcId, caller.id);
    const res = await promise;
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, "cancelled");
  });
});

describe("markCallsDelivered", () => {
  it("stamps delivered_at and second call to listPending filtered by status pending still returns them", async () => {
    const caller = seedAgent("usr_c", "caller");
    const host = seedAgent("usr_h", "host");
    befriend(caller.id, host.id);
    setAgentCapabilities(host.id, "usr_h", [
      { name: "mcp.host", tools: ["fs.read"] },
    ]);
    const p = dispatchToolCall({
      caller_agent_id: caller.id,
      tool_name: "fs.read",
      args: {},
      timeout_ms: 30_000,
    });
    const before = listPendingForAgent(host.id);
    assert.equal(before.length, 1);
    assert.equal(before[0].delivered_at, null);
    markCallsDelivered([before[0].id]);
    const after = listPendingForAgent(host.id);
    assert.equal(after[0].delivered_at != null, true);
    cancelCall(before[0].id, caller.id);
    await p;
  });
});
