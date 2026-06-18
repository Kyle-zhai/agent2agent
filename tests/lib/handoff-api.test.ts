import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createGroupConversation } from "../../lib/conversations";
import { createWorkspace } from "../../lib/workspaces";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { getHandoff, listHandoffsForUser } from "../../lib/handoffs";
import { GET as listHandoffsRoute, POST as proposeRoute } from "../../app/api/v1/handoffs/route";
import { POST as respondRoute } from "../../app/api/v1/handoffs/[id]/respond/route";
import { GET as heartbeatRoute } from "../../app/api/v1/heartbeat/route";

// A1 — agent-facing REST for directed handoffs. Proves a user's OWN local
// agent can propose context and the recipient's OWN agent can accept it over
// REST (no browser), and that heartbeat surfaces pending handoffs.

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

function setup() {
  const alice = seedUserAgent("usr_alice", "alice");
  const bob = seedUserAgent("usr_bob", "bob");
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
  return { alice, bob, conv, ws };
}

function bearer(url: string, key: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/v1/handoffs (propose)", () => {
  it("a local agent proposes a handoff to a peer's agent over REST", async () => {
    const { alice, bob, conv, ws } = setup();
    const res = await proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, {
        conversation_id: conv.id,
        to_agent_id: bob.agent.id,
        title: "Draft the schema",
        brief: "composite PK migration",
        body: "Please update schema.sql.\n[[private]]budget is 40k[[/private]]",
        workspace_id: ws.id,
        scopes: ["read", "comment", "write"],
        duration_key: "24h",
      }),
    );
    assert.equal(res.status, 201);
    const json = (await res.json()) as { handoff: { id: string; status: string; redaction_count: number; shared_body: string } };
    assert.equal(json.handoff.status, "proposed");
    // redaction ran: the private span is gone from shared_body and counted.
    assert.equal(json.handoff.redaction_count, 1);
    assert.ok(!json.handoff.shared_body.includes("40k"));
    // persisted, owned by alice→bob
    const h = getHandoff(json.handoff.id)!;
    assert.equal(h.from_user_id, "usr_alice");
    assert.equal(h.to_user_id, "usr_bob");
  });

  it("rejects a missing Bearer token with 401", async () => {
    const { bob, conv } = setup();
    const res = await proposeRoute(
      new Request("http://t.local/api/v1/handoffs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conv.id, to_agent_id: bob.agent.id, title: "x" }),
      }),
    );
    assert.equal(res.status, 401);
  });

  it("400s when required fields are missing", async () => {
    const { alice } = setup();
    const res = await proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, { title: "no convo" }),
    );
    assert.equal(res.status, 400);
  });

  it("400s when proposing to your OWN agent (lib authority gate)", async () => {
    const { alice, conv } = setup();
    // alice's second agent — same owner; proposeHandoff forbids self-handoff.
    const alice2 = createAgentForUser("usr_alice", { handle: "alice2", display_name: "alice2" });
    db()
      .prepare(
        "INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      )
      .run(conv.id, alice2.agent.id, NOW);
    const res = await proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, {
        conversation_id: conv.id,
        to_agent_id: alice2.agent.id,
        title: "self",
        body: "x",
      }),
    );
    assert.equal(res.status, 400);
  });
});

describe("POST /api/v1/handoffs/[id]/respond", () => {
  function propose(alice: ReturnType<typeof setup>["alice"], bob: ReturnType<typeof setup>["bob"], conv: { id: string }, ws: { id: string }) {
    return proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, {
        conversation_id: conv.id,
        to_agent_id: bob.agent.id,
        title: "Draft the schema",
        body: "Please update schema.sql.",
        workspace_id: ws.id,
        scopes: ["read", "comment", "write"],
      }),
    );
  }

  it("the recipient's agent accepts over REST — wires grant + collab task", async () => {
    const { alice, bob, conv, ws } = setup();
    const pid = ((await (await propose(alice, bob, conv, ws)).json()) as { handoff: { id: string } }).handoff.id;

    const res = await respondRoute(
      bearer(`http://t.local/api/v1/handoffs/${pid}/respond`, bob.apiKey, { decision: "accept" }),
      { params: Promise.resolve({ id: pid }) },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { handoff: { status: string; task_id: string | null } };
    assert.equal(json.handoff.status, "accepted");
    assert.ok(json.handoff.task_id, "accept should create a collab task");
    // grant minted for bob on the workspace
    const grants = db()
      .prepare("SELECT scopes_json FROM shared_grants WHERE to_agent_id = ? AND resource_id = ?")
      .all(bob.agent.id, ws.id) as Array<{ scopes_json: string }>;
    assert.ok(grants.length >= 1, "a workspace grant should exist for bob");
  });

  it("a NON-recipient agent gets 403 (only to_user's agent may respond)", async () => {
    const { alice, bob, conv, ws } = setup();
    const pid = ((await (await propose(alice, bob, conv, ws)).json()) as { handoff: { id: string } }).handoff.id;
    // alice (the proposer) tries to accept her own handoff → forbidden.
    const res = await respondRoute(
      bearer(`http://t.local/api/v1/handoffs/${pid}/respond`, alice.apiKey, { decision: "accept" }),
      { params: Promise.resolve({ id: pid }) },
    );
    assert.equal(res.status, 403);
    assert.equal(getHandoff(pid)!.status, "proposed");
  });

  it("decline works and 400s an invalid decision", async () => {
    const { alice, bob, conv, ws } = setup();
    const pid = ((await (await propose(alice, bob, conv, ws)).json()) as { handoff: { id: string } }).handoff.id;
    const bad = await respondRoute(
      bearer(`http://t.local/api/v1/handoffs/${pid}/respond`, bob.apiKey, { decision: "maybe" }),
      { params: Promise.resolve({ id: pid }) },
    );
    assert.equal(bad.status, 400);
    const ok = await respondRoute(
      bearer(`http://t.local/api/v1/handoffs/${pid}/respond`, bob.apiKey, { decision: "decline", note: "out of scope" }),
      { params: Promise.resolve({ id: pid }) },
    );
    assert.equal(ok.status, 200);
    assert.equal(getHandoff(pid)!.status, "declined");
  });

  it("404s an unknown handoff id", async () => {
    const { bob } = setup();
    const res = await respondRoute(
      bearer("http://t.local/api/v1/handoffs/nope/respond", bob.apiKey, { decision: "accept" }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    assert.equal(res.status, 404);
  });
});

describe("GET /api/v1/handoffs + heartbeat pending_handoffs", () => {
  it("lists handoffs the agent's user is a party to", async () => {
    const { alice, bob, conv, ws } = setup();
    await proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, {
        conversation_id: conv.id,
        to_agent_id: bob.agent.id,
        title: "T1",
        body: "x",
        workspace_id: ws.id,
      }),
    );
    // both parties see it
    for (const a of [alice, bob]) {
      const res = await listHandoffsRoute(bearer("http://t.local/api/v1/handoffs", a.apiKey));
      const json = (await res.json()) as { handoffs: Array<{ title: string }> };
      assert.equal(json.handoffs.length, 1);
      assert.equal(json.handoffs[0].title, "T1");
    }
    // a third unrelated user sees none
    const carol = seedUserAgent("usr_carol", "carol");
    assert.equal(listHandoffsForUser("usr_carol").length, 0);
    void carol;
  });

  it("heartbeat surfaces pending_handoffs for the recipient with a respond_url", async () => {
    const { alice, bob, conv, ws } = setup();
    await proposeRoute(
      bearer("http://t.local/api/v1/handoffs", alice.apiKey, {
        conversation_id: conv.id,
        to_agent_id: bob.agent.id,
        title: "Needs you",
        body: "x",
        workspace_id: ws.id,
      }),
    );
    const res = await heartbeatRoute(bearer("http://t.local/api/v1/heartbeat", bob.apiKey));
    const json = (await res.json()) as {
      pending_handoffs: Array<{ id: string; title: string; respond_url: string }>;
    };
    assert.equal(json.pending_handoffs.length, 1);
    assert.equal(json.pending_handoffs[0].title, "Needs you");
    assert.match(json.pending_handoffs[0].respond_url, /\/api\/v1\/handoffs\/.+\/respond$/);

    // the PROPOSER's heartbeat does NOT list it as pending (it's not theirs to accept)
    const aliceHb = await heartbeatRoute(bearer("http://t.local/api/v1/heartbeat", alice.apiKey));
    const aliceJson = (await aliceHb.json()) as { pending_handoffs: unknown[] };
    assert.equal(aliceJson.pending_handoffs.length, 0);
  });
});
