import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createGroupConversation, sendMessage } from "../../lib/conversations";
import { createWorkspace, applyPatch, getWorkspace } from "../../lib/workspaces";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { createGrant } from "../../lib/grants";
import { createTask } from "../../lib/tasks";
import { GET as getMessages } from "../../app/api/v1/conversations/[id]/messages/route";
import { GET as getTask, PATCH as patchTask } from "../../app/api/v1/tasks/[id]/route";
import { POST as resolveConflict } from "../../app/api/v1/workspaces/[id]/conflicts/resolve/route";

// A2 — grant enforcement on conversation/task REST reads + the workspace 409
// conflict-resolution endpoint. Proves a granted (non-member / non-assignee)
// agent can act over REST, and that a local agent can resolve a 409.

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
beforeEach(() => resetTables(db()));

function seedUserAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle });
}

function bearer(url: string, key: string, body?: unknown, method?: string): Request {
  return new Request(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function world() {
  const alice = seedUserAgent("usr_alice", "alice");
  const bob = seedUserAgent("usr_bob", "bob");
  const carol = seedUserAgent("usr_carol", "carol"); // NON-member outsider
  const req = sendFriendRequest("usr_alice", alice.agent.id, bob.agent.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation("usr_alice", alice.agent.id, "Project X", [
    bob.agent.id,
  ]);
  const ws = createWorkspace({
    name: "shared",
    conversation_id: conv.id,
    created_by_agent_id: alice.agent.id,
  });
  return { alice, bob, carol, conv, ws };
}

describe("A2 · conversation messages honor a read grant", () => {
  it("non-member WITH a conversation read grant can read; WITHOUT → 403", async () => {
    const { alice, carol, conv } = world();
    sendMessage(conv.id, alice.agent.id, { text: "hello room" });

    // carol is not a member → denied
    const denied = await getMessages(
      bearer(`http://t.local/api/v1/conversations/${conv.id}/messages`, carol.apiKey),
      { params: Promise.resolve({ id: conv.id }) },
    );
    assert.equal(denied.status, 403);

    // alice (member) grants carol conversation:read → now allowed
    createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.agent.id,
      to_agent_id: carol.agent.id,
      resource_type: "conversation",
      resource_id: conv.id,
      scopes: ["read"],
      duration_key: "24h",
    });
    const ok = await getMessages(
      bearer(`http://t.local/api/v1/conversations/${conv.id}/messages`, carol.apiKey),
      { params: Promise.resolve({ id: conv.id }) },
    );
    assert.equal(ok.status, 200);
    const json = (await ok.json()) as { messages: Array<{ text: string }> };
    assert.equal(json.messages[0].text, "hello room");
  });
});

describe("A2 · task reads/comments honor task grants", () => {
  it("non-owner/assignee WITH a task read grant can GET; comment grant can comment; none → 403", async () => {
    const { alice, carol, conv } = world();
    const task = createTask({
      conversation_id: conv.id,
      title: "Do the thing",
      description: "",
      owner_agent_id: alice.agent.id,
    });

    // carol: no relation → 403 on GET
    const denied = await getTask(
      bearer(`http://t.local/api/v1/tasks/${task.id}`, carol.apiKey),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(denied.status, 403);

    // grant carol task:read+comment
    createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.agent.id,
      to_agent_id: carol.agent.id,
      resource_type: "task",
      resource_id: task.id,
      scopes: ["read", "comment"],
      duration_key: "24h",
    });

    const okGet = await getTask(
      bearer(`http://t.local/api/v1/tasks/${task.id}`, carol.apiKey),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(okGet.status, 200);

    const okComment = await patchTask(
      bearer(`http://t.local/api/v1/tasks/${task.id}`, carol.apiKey, { comment: "looks good" }, "PATCH"),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(okComment.status, 200);
  });
});

describe("A2 · workspace conflict resolution endpoint", () => {
  function seedFile(ws: { id: string; head_snapshot_id: string | null }, agentId: string, path: string, content: string) {
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: agentId,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path, op: "create", content: Buffer.from(content, "utf8") }],
      commit_message: "seed",
    });
    if (!r.ok) throw new Error("seed failed");
    return r.snapshot_id;
  }

  it('"mine" writes my content as a new snapshot; head advances', async () => {
    const { alice, ws } = world();
    const head = seedFile(ws, alice.agent.id, "doc.md", "v0\n");
    const res = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, alice.apiKey, {
        against_rev: head,
        resolutions: [{ path: "doc.md", choice: "mine", content: "v-mine\n" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { resolved: boolean; snapshot_id: string };
    assert.equal(json.resolved, true);
    assert.notEqual(json.snapshot_id, head, "a new snapshot should be created");
  });

  it('all-"theirs" makes no new snapshot (head kept)', async () => {
    const { alice, ws } = world();
    const head = seedFile(ws, alice.agent.id, "doc.md", "v0\n");
    const res = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, alice.apiKey, {
        against_rev: head,
        resolutions: [{ path: "doc.md", choice: "theirs" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { resolved: boolean; snapshot_id: string; changed: unknown[] };
    assert.equal(json.snapshot_id, head, "head unchanged when keeping theirs");
    assert.equal(json.changed.length, 0);
  });

  it("write-gates: outsider without access 403; with a write grant, allowed", async () => {
    const { alice, carol, ws } = world();
    const head = seedFile(ws, alice.agent.id, "doc.md", "v0\n");

    const denied = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, carol.apiKey, {
        against_rev: head,
        resolutions: [{ path: "doc.md", choice: "mine", content: "x\n" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(denied.status, 403);

    createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.agent.id,
      to_agent_id: carol.agent.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read", "write"],
      duration_key: "24h",
    });
    const ok = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, carol.apiKey, {
        against_rev: getWorkspace(ws.id)!.head_snapshot_id,
        resolutions: [{ path: "doc.md", choice: "mine", content: "x\n" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(ok.status, 200);
  });

  it("re-conflicts (409) when against_rev is stale on the same path", async () => {
    const { alice, ws } = world();
    const s0 = seedFile(ws, alice.agent.id, "doc.md", "v0\n");
    // head moves on the same path
    const s1 = applyPatch({
      workspace_id: ws.id,
      agent_id: alice.agent.id,
      against_rev: s0,
      ops: [{ path: "doc.md", op: "modify", content: Buffer.from("v1\n", "utf8") }],
      commit_message: "advance",
    });
    assert.ok(s1.ok);
    // resolving against the STALE s0 with a conflicting same-path edit → 409
    const res = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, alice.apiKey, {
        against_rev: s0,
        resolutions: [{ path: "doc.md", choice: "mine", content: "v2\n" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(res.status, 409);
  });

  it("400s missing against_rev / empty resolutions", async () => {
    const { alice, ws } = world();
    const r1 = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, alice.apiKey, {
        resolutions: [{ path: "x", choice: "theirs" }],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(r1.status, 400);
    const r2 = await resolveConflict(
      bearer(`http://t.local/api/v1/workspaces/${ws.id}/conflicts/resolve`, alice.apiKey, {
        against_rev: ws.head_snapshot_id,
        resolutions: [],
      }),
      { params: Promise.resolve({ id: ws.id }) },
    );
    assert.equal(r2.status, 400);
  });
});
