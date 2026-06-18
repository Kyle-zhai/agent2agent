import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { getAgent, authenticateAgent } from "../../lib/agents";
import {
  DEVICE_AUTH_TTL_MS,
  approveDeviceAuth,
  createDeviceAuthRequest,
  denyDeviceAuth,
  getPendingByUserCode,
  normalizeUserCode,
  pollDeviceAuth,
} from "../../lib/device-auth";

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
}

describe("normalizeUserCode", () => {
  it("accepts dashed, bare, lowercase, and spaced inputs", () => {
    assert.equal(normalizeUserCode("BCDF-2345"), "BCDF-2345");
    assert.equal(normalizeUserCode("bcdf2345"), "BCDF-2345");
    assert.equal(normalizeUserCode(" bcdf 2345 "), "BCDF-2345");
    assert.equal(normalizeUserCode("nope"), "");
  });
});

describe("device authorization flow", () => {
  it("happy path: request → approve → poll delivers the key exactly once", () => {
    seedUser("usr_o", "owner");
    const created = createDeviceAuthRequest({
      agent_name: "My Laptop Agent",
      platform: "claude-code",
    });
    assert.match(created.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(created.device_code.startsWith("dvc_"));
    assert.equal(created.interval, 5);

    // Pending until approved.
    assert.deepEqual(pollDeviceAuth(created.device_code), { status: "pending" });

    const pending = getPendingByUserCode(created.user_code.toLowerCase());
    assert.ok(pending);
    assert.equal(pending!.agent_name, "My Laptop Agent");

    const { agent } = approveDeviceAuth("usr_o", created.user_code, {
      handle: "laptop",
      display_name: "My Laptop Agent",
    });
    assert.equal(agent.owner_user_id, "usr_o");
    assert.equal(agent.framework, "claude-code");

    // First poll claims the key…
    const result = pollDeviceAuth(created.device_code);
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") return;
    assert.equal(result.agent_id, agent.id);
    assert.ok(result.api_key.startsWith("a2a_"));
    // …and the key actually authenticates as the new agent.
    assert.equal(authenticateAgent(result.api_key)?.id, agent.id);

    // Second poll can NOT re-fetch the credential.
    assert.deepEqual(pollDeviceAuth(created.device_code), { status: "claimed" });
    // Plaintext key is gone from the row.
    const row = db()
      .prepare("SELECT api_key FROM device_auth_requests WHERE device_code = ?")
      .get(created.device_code) as { api_key: string | null };
    assert.equal(row.api_key, null);
  });

  it("deny: poll reports denied and no agent is created", () => {
    seedUser("usr_o", "owner");
    const created = createDeviceAuthRequest({ agent_name: "Sneaky" });
    denyDeviceAuth("usr_o", created.user_code);
    assert.deepEqual(pollDeviceAuth(created.device_code), { status: "denied" });
    const agents = db().prepare("SELECT COUNT(*) AS n FROM agents").get() as {
      n: number;
    };
    assert.equal(agents.n, 0);
  });

  it("expiry: a stale pending request can't be approved or polled to success", () => {
    seedUser("usr_o", "owner");
    const created = createDeviceAuthRequest({});
    NOW += DEVICE_AUTH_TTL_MS + 1000;
    assert.deepEqual(pollDeviceAuth(created.device_code), { status: "expired" });
    assert.equal(getPendingByUserCode(created.user_code), null);
    assert.throws(
      () =>
        approveDeviceAuth("usr_o", created.user_code, {
          handle: "late",
          display_name: "Too late",
        }),
      /expired/i,
    );
  });

  it("unknown / garbage device codes report expired, never throw", () => {
    assert.deepEqual(pollDeviceAuth("dvc_nope"), { status: "expired" });
    assert.deepEqual(pollDeviceAuth("x".repeat(500)), { status: "expired" });
  });

  it("unsupported platform falls back to the generic framework", () => {
    seedUser("usr_o", "owner");
    const created = createDeviceAuthRequest({ platform: "hermes_agent" });
    const { agent } = approveDeviceAuth("usr_o", created.user_code, {
      handle: "hermes",
      display_name: "Hermes",
    });
    assert.equal(getAgent(agent.id)!.framework, "generic");
  });

  it("approving twice with the same code fails the second time", () => {
    seedUser("usr_o", "owner");
    const created = createDeviceAuthRequest({});
    approveDeviceAuth("usr_o", created.user_code, {
      handle: "first",
      display_name: "First",
    });
    assert.throws(
      () =>
        approveDeviceAuth("usr_o", created.user_code, {
          handle: "second",
          display_name: "Second",
        }),
      /not found|used|expired/i,
    );
  });
});
