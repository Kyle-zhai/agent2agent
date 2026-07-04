import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { buildAiCatalog } from "../../lib/ard";

const BASE = "https://hub.test";
let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});
after(() => {
  Date.now = RealDateNow;
  delete process.env.A2A_PUBLIC_AGENT_IDS;
  _resetDbForTests();
  teardownTestDb();
});
beforeEach(() => {
  resetTables(db());
  NOW = 1_700_000_000_000;
  delete process.env.A2A_PUBLIC_AGENT_IDS;
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

/** Force an agent to be managed (publicDirectoryAgents only lists managed). */
function makeManaged(agentId: string) {
  db().prepare("UPDATE agents SET agent_kind = 'managed' WHERE id = ?").run(agentId);
}

describe("ARD ai-catalog — deny-by-default", () => {
  it("lists only the platform card when no agents are allowlisted", () => {
    seedUser("u1", "alice");
    const cat = buildAiCatalog(BASE);
    assert.equal(cat.version, "0.9");
    assert.equal(cat.entries.length, 1);
    assert.equal(cat.entries[0].identifier, "urn:air:hub.test:platform:agent2agent");
    assert.equal(cat.entries[0].url, `${BASE}/.well-known/agent-card.json`);
    assert.equal(cat.entries[0].type, "application/a2a-agent-card+json");
  });

  it("lists an allowlisted MANAGED agent with a domain-anchored URN + card url", () => {
    const a = seedUser("u1", "alice");
    makeManaged(a.id);
    process.env.A2A_PUBLIC_AGENT_IDS = a.id;
    const cat = buildAiCatalog(BASE);
    assert.equal(cat.entries.length, 2);
    const entry = cat.entries.find((e) => e.identifier.includes(":agents:"));
    assert.ok(entry);
    assert.equal(entry.identifier, `urn:air:hub.test:agents:${a.id}`);
    assert.equal(entry.url, `${BASE}/api/v1/agents/${a.id}/.well-known/agent-card.json`);
    assert.equal(entry.type, "application/a2a-agent-card+json");
  });

  it("never lists a NON-managed (external user) agent even if allowlisted", () => {
    const a = seedUser("u1", "alice"); // default agent_kind is not 'managed'
    process.env.A2A_PUBLIC_AGENT_IDS = a.id;
    const cat = buildAiCatalog(BASE);
    // only the platform entry — the user agent is filtered out by kind
    assert.equal(cat.entries.length, 1);
    assert.ok(cat.entries.every((e) => !e.identifier.includes(":agents:")));
  });

  it("falls back to a safe host when baseUrl is malformed", () => {
    const cat = buildAiCatalog("not-a-url");
    assert.equal(cat.entries[0].identifier, "urn:air:localhost:platform:agent2agent");
  });
});
