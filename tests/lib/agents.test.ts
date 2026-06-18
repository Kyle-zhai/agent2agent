import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent, deleteAgentForUser } from "../../lib/agents";
import { sendMessage, saveAttachment } from "../../lib/conversations";
import { createTask, getTask } from "../../lib/tasks";
import { createWorkspace } from "../../lib/workspaces";
import { newConversationId } from "../../lib/ids";

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
  NOW = 1_700_000_000_000;
  resetTables(db());
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function makeConv(memberIds: string[], creatorId: string) {
  const id = newConversationId();
  db()
    .prepare(
      `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
       VALUES (?, 'group', 'g', ?, ?)`,
    )
    .run(id, creatorId, NOW);
  for (const m of memberIds) {
    db()
      .prepare(
        `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(id, m, NOW);
  }
  return { id };
}

describe("deleteAgentForUser — cascade past unguarded agent FKs", () => {
  it("deletes an agent that has messages, attachments, tasks, workspaces (was a FK-violation crash)", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const conv = makeConv([alice.id, bob.id], alice.id);

    // Content authored by alice across the unguarded-FK tables.
    sendMessage(conv.id, alice.id, { text: "hi from alice", kind: "agent_to_agent" });
    const att = saveAttachment(alice.id, {
      filename: "a.txt",
      mime_type: "text/plain",
      bytes: Buffer.from("data"),
    });
    const ws = createWorkspace({ name: "w", conversation_id: conv.id, created_by_agent_id: alice.id });
    const task = createTask({
      title: "owned by alice",
      owner_agent_id: alice.id,
      assigned_to_agent_id: bob.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });

    // The bug: this used to throw SQLITE_CONSTRAINT_FOREIGNKEY.
    assert.doesNotThrow(() => deleteAgentForUser(alice.id, "usr_a"));

    // Agent gone; its authored content gone.
    assert.equal(getAgent(alice.id), null);
    assert.equal(
      (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent_id = ?").get(alice.id) as { n: number }).n,
      0,
    );
    assert.equal(
      (db().prepare("SELECT COUNT(*) AS n FROM attachments WHERE id = ?").get(att.id) as { n: number }).n,
      0,
    );
    assert.equal(getTask(task.id), null);
    // bob (and his data) survive.
    assert.ok(getAgent(bob.id));
  });

  it("REASSIGNS a multi-member conversation it created (doesn't nuke peers' room)", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const conv = makeConv([alice.id, bob.id], alice.id); // alice created
    sendMessage(conv.id, bob.id, { text: "bob's message", kind: "agent_to_agent" });

    deleteAgentForUser(alice.id, "usr_a");

    // Conversation survives, ownership handed to bob, bob's message intact.
    const row = db()
      .prepare("SELECT created_by_agent_id FROM conversations WHERE id = ?")
      .get(conv.id) as { created_by_agent_id: string } | undefined;
    assert.ok(row, "conversation must survive");
    assert.equal(row!.created_by_agent_id, bob.id);
    assert.equal(
      (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conv.id) as { n: number }).n,
      1,
    );
  });

  it("DELETES a solo conversation it created (no other member to hand off to)", () => {
    const alice = seedUser("usr_a", "alice");
    const conv = makeConv([alice.id], alice.id);
    deleteAgentForUser(alice.id, "usr_a");
    assert.equal(
      db().prepare("SELECT id FROM conversations WHERE id = ?").get(conv.id),
      undefined,
    );
  });

  it("SET NULLs nullable attribution refs instead of failing (workspace creator)", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const conv = makeConv([alice.id, bob.id], bob.id); // bob created, alice just a member
    const ws = createWorkspace({ name: "w", conversation_id: conv.id, created_by_agent_id: alice.id });
    deleteAgentForUser(alice.id, "usr_a");
    // Workspace survives (bob's conversation), creator attribution nulled.
    const row = db()
      .prepare("SELECT created_by_agent_id FROM workspaces WHERE id = ?")
      .get(ws.id) as { created_by_agent_id: string | null } | undefined;
    assert.ok(row, "workspace must survive");
    assert.equal(row!.created_by_agent_id, null);
  });

  it("refuses to delete an agent the user doesn't own", () => {
    seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    assert.throws(() => deleteAgentForUser(bob.id, "usr_a"), /not found/i);
  });
});
