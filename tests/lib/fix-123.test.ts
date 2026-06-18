import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createGroupConversation } from "../../lib/conversations";
import { createWorkspace } from "../../lib/workspaces";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { createGrant } from "../../lib/grants";
import { createTask } from "../../lib/tasks";
import { POST as postTask } from "../../app/api/v1/tasks/route";
import { POST as postComment } from "../../app/api/v1/tasks/[id]/comments/route";
import { GET as getInstallMd } from "../../app/install.md/route";
import { GET as getOpenClawMd } from "../../app/install/openclaw.md/route";

// fix-123 — ② tightened POST /api/v1/tasks authz (workspace + assignee
// boundary), ③ comment-grant parity on POST /tasks/[id]/comments, and ① the
// install-layer surfacing of the handoff REST as agent skills.

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

function befriend(aUser: string, aAgent: string, bUser: string, bAgent: string) {
  const req = sendFriendRequest(aUser, aAgent, bAgent);
  acceptFriendRequest(bUser, req.id);
}

/** alice + bob are friends and share conversation "Project X" with a
 *  conversation-bound workspace alice created (alice is admin/subscriber).
 *  carol is a friendly NON-member outsider. */
function world() {
  const alice = seedUserAgent("usr_alice", "alice");
  const bob = seedUserAgent("usr_bob", "bob");
  const carol = seedUserAgent("usr_carol", "carol");
  befriend("usr_alice", alice.agent.id, "usr_bob", bob.agent.id);
  befriend("usr_alice", alice.agent.id, "usr_carol", carol.agent.id);
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

const TASKS_URL = "http://t.local/api/v1/tasks";

describe("fix-② · POST /api/v1/tasks authz boundary", () => {
  it("rejects a workspace bound to a DIFFERENT conversation (400)", async () => {
    const { alice, conv } = world();
    // A second conversation alice is in, with its own bound workspace.
    const dave = seedUserAgentInOther(alice);
    const other = createGroupConversation("usr_alice", alice.agent.id, "Other", [
      dave.id,
    ]);
    const otherWs = createWorkspace({
      name: "other-ws",
      conversation_id: other.id,
      created_by_agent_id: alice.agent.id,
    });
    const res = await postTask(
      bearer(TASKS_URL, alice.apiKey, {
        title: "wire foreign ws",
        conversation_id: conv.id,
        workspace_id: otherWs.id,
      }),
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /different conversation/);
  });

  it("rejects a creator with NO access to the workspace (403)", async () => {
    const { alice, bob, conv } = world();
    // A workspace bob owns, NOT bound to any conversation and alice is not
    // subscribed to → alice (a conv member) cannot attach it.
    const bobWs = createWorkspace({
      name: "bobs-private",
      conversation_id: null,
      created_by_agent_id: bob.agent.id,
    });
    const res = await postTask(
      bearer(TASKS_URL, alice.apiKey, {
        title: "attach a ws I can't see",
        conversation_id: conv.id,
        workspace_id: bobWs.id,
      }),
    );
    assert.equal(res.status, 403);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /no access to that workspace/);
  });

  it("rejects an assignee who is NOT a member of the conversation (400)", async () => {
    const { alice, carol, conv } = world();
    // carol is a friend but NOT in conv → cannot be assigned within it.
    const res = await postTask(
      bearer(TASKS_URL, alice.apiKey, {
        title: "assign an outsider",
        conversation_id: conv.id,
        assigned_to_agent_id: carol.agent.id,
      }),
    );
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /not a member of this conversation/);
  });

  it("happy path: member + own workspace + member assignee → 201", async () => {
    const { alice, bob, conv, ws } = world();
    const res = await postTask(
      bearer(TASKS_URL, alice.apiKey, {
        title: "legit task",
        conversation_id: conv.id,
        workspace_id: ws.id,
        assigned_to_agent_id: bob.agent.id,
      }),
    );
    assert.equal(res.status, 201);
    const json = (await res.json()) as {
      task: { workspace_id: string; assigned_to_agent_id: string; status: string };
    };
    assert.equal(json.task.workspace_id, ws.id);
    assert.equal(json.task.assigned_to_agent_id, bob.agent.id);
    assert.equal(json.task.status, "assigned");
  });

  it("creator may attach a workspace via a read GRANT (not just subscription)", async () => {
    const { alice, bob, carol, conv } = world();
    // Add carol to conv so she clears the membership gate. (alice owns conv;
    // membership is added directly.)
    db()
      .prepare(
        "INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      )
      .run(conv.id, carol.agent.id, NOW);
    // bob's standalone workspace; alice grants carol read on it.
    const bobWs = createWorkspace({
      name: "bobs-ws",
      conversation_id: null,
      created_by_agent_id: bob.agent.id,
    });
    // bob (subscriber) grants carol a read grant on his workspace.
    createGrant({
      from_user_id: "usr_bob",
      from_agent_id: bob.agent.id,
      to_agent_id: carol.agent.id,
      resource_type: "workspace",
      resource_id: bobWs.id,
      scopes: ["read"],
      duration_key: "24h",
    });
    const res = await postTask(
      bearer(TASKS_URL, carol.apiKey, {
        title: "task with granted ws",
        conversation_id: conv.id,
        workspace_id: bobWs.id,
      }),
    );
    assert.equal(res.status, 201);
  });
});

describe("fix-③ · POST /tasks/[id]/comments honors a comment grant", () => {
  it("owner can comment; granted non-owner can comment; ungranted → 403", async () => {
    const { alice, carol, conv } = world();
    const task = createTask({
      conversation_id: conv.id,
      title: "Do the thing",
      description: "",
      owner_agent_id: alice.agent.id,
    });
    const url = `http://t.local/api/v1/tasks/${task.id}/comments`;
    const params = { params: Promise.resolve({ id: task.id }) };

    // owner comments → ok
    const ownerRes = await postComment(
      bearer(url, alice.apiKey, { body: "owner note" }),
      params,
    );
    assert.equal(ownerRes.status, 200);

    // carol (no relation) → 403
    const denied = await postComment(
      bearer(url, carol.apiKey, { body: "hi" }),
      params,
    );
    assert.equal(denied.status, 403);

    // grant carol task:comment → now allowed
    createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.agent.id,
      to_agent_id: carol.agent.id,
      resource_type: "task",
      resource_id: task.id,
      scopes: ["comment"],
      duration_key: "24h",
    });
    const granted = await postComment(
      bearer(url, carol.apiKey, { body: "granted comment" }),
      params,
    );
    assert.equal(granted.status, 200);
  });
});

describe("fix-① · install layer surfaces the handoff skills", () => {
  it("install.md exposes handoff_propose.sh against /api/v1/handoffs", async () => {
    const res = await getInstallMd(new Request("http://t.local/install.md"));
    const body = await res.text();
    assert.match(body, /handoff_propose\.sh/);
    assert.match(body, /handoff_respond\.sh/);
    assert.match(body, /\/api\/v1\/handoffs/);
    assert.match(body, /pending_handoffs/);
  });

  it("openclaw manifest registers agent2agent.handoff_propose / _respond", async () => {
    const res = await getOpenClawMd(new Request("http://t.local/install/openclaw.md"));
    const body = await res.text();
    assert.match(body, /agent2agent\.handoff_propose/);
    assert.match(body, /agent2agent\.handoff_respond/);
    assert.match(body, /handoff_propose\.sh/);
  });
});

// Helper used by the "different conversation" test: a fresh friend of alice so
// she can open a second group conversation.
function seedUserAgentInOther(alice: { agent: { id: string } }) {
  const dave = seedUserAgent("usr_dave", "dave");
  befriend("usr_alice", alice.agent.id, "usr_dave", dave.agent.id);
  return dave.agent;
}
