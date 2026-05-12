import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  createInvite,
  getInviteByCode,
  redeemInvite,
  revokeInvite,
} from "../../lib/invites";

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

function seedUserWithAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
}

describe("createInvite", () => {
  it("creates with default ttl and 1 max_use", () => {
    const u = seedUserWithAgent("usr_a", "alpha");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: u.id,
    });
    assert.ok(inv.code.length > 10);
    assert.equal(inv.max_uses, 1);
    assert.equal(inv.used_count, 0);
    assert.ok(inv.expires_at && inv.expires_at > NOW);
  });

  it("refuses if agent isn't owned by user", () => {
    const u = seedUserWithAgent("usr_a", "alpha");
    seedUserWithAgent("usr_b", "bravo");
    assert.throws(
      () =>
        createInvite({
          user_id: "usr_b",
          inviter_agent_id: u.id,
        }),
      /don't own/,
    );
  });
});

describe("redeemInvite", () => {
  it("happy path: redeemer + inviter become friends after redeem", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const bob = seedUserWithAgent("usr_b", "bravo");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
    });
    const r = redeemInvite({
      code: inv.code,
      redeemer_user_id: "usr_b",
      redeemer_agent_id: bob.id,
    });
    assert.equal(r.invite.used_count, 1);

    // Check friendship in db (sorted pair)
    const [x, y] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id];
    const row = db()
      .prepare(
        "SELECT 1 FROM friendships WHERE agent_a = ? AND agent_b = ?",
      )
      .get(x, y);
    assert.ok(row, "friendship should exist");
  });

  it("refuses self-redeem", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
    });
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_a",
          redeemer_agent_id: alice.id,
        }),
      /your own/,
    );
  });

  it("refuses expired invite", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const bob = seedUserWithAgent("usr_b", "bravo");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
      ttl_ms: 60_000,
    });
    NOW += 120_000;
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_b",
          redeemer_agent_id: bob.id,
        }),
      /expired/,
    );
  });

  it("refuses to redeem same invite twice from the same user", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const bob = seedUserWithAgent("usr_b", "bravo");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
      max_uses: 5,
    });
    redeemInvite({
      code: inv.code,
      redeemer_user_id: "usr_b",
      redeemer_agent_id: bob.id,
    });
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_b",
          redeemer_agent_id: bob.id,
        }),
      /already redeemed/,
    );
  });

  it("refuses to redeem after max_uses exhausted", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const bob = seedUserWithAgent("usr_b", "bravo");
    const carol = seedUserWithAgent("usr_c", "carol");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
      max_uses: 1,
    });
    redeemInvite({
      code: inv.code,
      redeemer_user_id: "usr_b",
      redeemer_agent_id: bob.id,
    });
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_c",
          redeemer_agent_id: carol.id,
        }),
      /fully used/,
    );
  });

  it("refuses if redeemer has no agents", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    db()
      .prepare(
        "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("usr_lonely", "l@t.test", "L", "x".repeat(128), "y".repeat(32), NOW);
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
    });
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_lonely",
        }),
      /agent/,
    );
  });
});

describe("revokeInvite", () => {
  it("only the creator can revoke", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    seedUserWithAgent("usr_b", "bravo");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
    });
    assert.throws(() => revokeInvite("usr_b", inv.id), /Not your invite/);
  });

  it("revoke removes the row and blocks future redeem", () => {
    const alice = seedUserWithAgent("usr_a", "alpha");
    const bob = seedUserWithAgent("usr_b", "bravo");
    const inv = createInvite({
      user_id: "usr_a",
      inviter_agent_id: alice.id,
    });
    revokeInvite("usr_a", inv.id);
    assert.equal(getInviteByCode(inv.code), null);
    assert.throws(
      () =>
        redeemInvite({
          code: inv.code,
          redeemer_user_id: "usr_b",
          redeemer_agent_id: bob.id,
        }),
      /not found/,
    );
  });
});
