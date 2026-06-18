import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  createGroupConversation,
  addGroupMember,
  sendMessage,
  listConversationsWithState,
} from "../../lib/conversations";

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
});

function seedAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
}
function befriend(a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare("INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)")
    .run(x, y, NOW);
}

// Audit (HIGH): a member added mid-conversation had last_read_message_id=NULL,
// which the unread calculation treats as "read from time 0" — inflating their
// unread to the entire pre-join backlog. addGroupMember now anchors the cursor.
describe("addGroupMember unread anchoring", () => {
  it("anchors a new member's read cursor at the latest message (no pre-join unread)", () => {
    const owner = seedAgent("usr_o", "owner");
    const member = seedAgent("usr_m", "member");
    const late = seedAgent("usr_l", "latejoin");
    befriend(owner.id, member.id);
    befriend(owner.id, late.id);
    const conv = createGroupConversation("usr_o", owner.id, "team", [member.id]);

    // Distinct timestamps so "latest message" is unambiguous (Date.now is mocked).
    let lastId = "";
    for (let i = 0; i < 3; i++) {
      NOW = 1_700_000_000_000 + (i + 1) * 1000;
      lastId = sendMessage(conv.id, owner.id, { text: `msg ${i}` }).id;
    }

    addGroupMember(conv.id, owner.id, late.id);
    const row = db()
      .prepare(
        "SELECT last_read_message_id FROM conversation_members WHERE conversation_id=? AND agent_id=?",
      )
      .get(conv.id, late.id) as { last_read_message_id: string | null };
    assert.equal(row.last_read_message_id, lastId, "new member starts read up to the latest message");
  });

  // Audit (MEDIUM): unread excluded only the viewing agent, so a human's OWN
  // second agent's messages showed as unread to that human. Now excludes all of
  // the user's agents.
  it("messages from ANY of the user's own agents are not unread to that user", () => {
    const a1 = seedAgent("usr_u", "minea"); // user usr_u, agent A
    const a2 = createAgentForUser("usr_u", { handle: "mineb", display_name: "MineB" }).agent; // same user, agent B
    const peer = seedAgent("usr_p", "peer");
    befriend(a1.id, a2.id);
    befriend(a1.id, peer.id);
    befriend(a2.id, peer.id);
    const conv = createGroupConversation("usr_u", a1.id, "team", [a2.id, peer.id]);
    const findConv = () =>
      listConversationsWithState("usr_u").find((c) => c.conversation.id === conv.id)!;

    // usr_u's OTHER own agent posts → must not count as unread to usr_u.
    NOW = 1_700_000_001_000;
    sendMessage(conv.id, a2.id, { text: "from my other agent" });
    assert.equal(findConv().unread_count, 0, "own agent's message is not unread");

    // the peer posts → IS unread.
    NOW = 1_700_000_002_000;
    sendMessage(conv.id, peer.id, { text: "from the peer" });
    assert.ok(findConv().unread_count >= 1, "peer's message is unread");
  });

  it("leaves the cursor NULL when joining a conversation with no messages", () => {
    const owner = seedAgent("usr_o", "owner");
    const member = seedAgent("usr_m", "member");
    const late = seedAgent("usr_l", "latejoin");
    befriend(owner.id, member.id);
    befriend(owner.id, late.id);
    const conv = createGroupConversation("usr_o", owner.id, "team", [member.id]);
    addGroupMember(conv.id, owner.id, late.id);
    const row = db()
      .prepare(
        "SELECT last_read_message_id FROM conversation_members WHERE conversation_id=? AND agent_id=?",
      )
      .get(conv.id, late.id) as { last_read_message_id: string | null };
    assert.equal(row.last_read_message_id, null);
  });
});
