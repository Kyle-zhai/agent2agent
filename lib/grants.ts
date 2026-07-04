import "server-only";
import { db } from "./db";
import { newGrantId } from "./ids";
import { signGrantPayload, verifyGrantSignature } from "./crypto";
import { getAgent } from "./agents";
import { getWorkspace, canRead, canWrite } from "./workspaces";
import { getConversation, listMembers } from "./conversations";
import { getTask } from "./tasks";
import { logAudit } from "./audit";
import type {
  GrantResourceType,
  GrantScope,
  SharedGrant,
} from "./types";

export type { GrantResourceType, GrantScope, SharedGrant } from "./types";

// ---------------------------------------------------------------------------
// Capability-scoped grants — UCAN-inspired delegation
//
// Big idea: instead of flipping a peer's agent to "writer" on an entire
// workspace when a handoff is accepted, we mint a SignedGrant pinned to a
// specific resource (workspace / file / conversation / task), with a
// specific scope set, optionally time-bound. Verification is a
// HMAC-equal check so revocation is cheap (flag the row) and tampering
// breaks the signature.
//
// Each grant is its own audit-able row. Listing "what does Bob's agent
// have access to that's not their own?" becomes one query rather than
// joining subscriptions, friendships, and handoffs.
// ---------------------------------------------------------------------------

const GRANT_COLUMNS =
  "id, from_agent_id, from_user_id, to_agent_id, to_user_id, " +
  "resource_type, resource_id, scopes_json, handoff_id, signature, " +
  "expires_at, revoked_at, revoked_reason, last_used_at, created_at";

export const ALL_SCOPES: readonly GrantScope[] = [
  "read",
  "comment",
  "write",
  "admin",
] as const;

export const ALL_RESOURCE_TYPES: readonly GrantResourceType[] = [
  "workspace",
  "file",
  "conversation",
  "task",
] as const;

// Pre-baked expiry presets surfaced to the UI as chips. Server still
// accepts a raw `expires_at` for advanced callers.
export const DURATION_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  ms: number | null;
}> = [
  { key: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { key: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "forever", label: "No expiry", ms: null },
];

// Canonical serialisation used for HMAC signing — sorted keys, no
// whitespace, fixed field order. If the schema ever evolves, version
// this canonicalizer (`v2:…`) and accept both during a migration window
// so existing grants stay verifiable.
function canonicalPayload(input: {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  scopes: GrantScope[];
  expires_at: number | null;
  created_at: number;
}): string {
  const ordered: Record<string, unknown> = {
    created_at: input.created_at,
    expires_at: input.expires_at,
    from_agent_id: input.from_agent_id,
    id: input.id,
    resource_id: input.resource_id,
    resource_type: input.resource_type,
    scopes: [...input.scopes].sort(),
    to_agent_id: input.to_agent_id,
  };
  return `v1:${JSON.stringify(ordered)}`;
}

function isValidScope(s: unknown): s is GrantScope {
  return typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s);
}

function isValidResourceType(s: unknown): s is GrantResourceType {
  return (
    typeof s === "string" && (ALL_RESOURCE_TYPES as readonly string[]).includes(s)
  );
}

/** Resource existence check. Pinning to a real row means a grant for a
 *  deleted workspace surfaces immediately at create time, not later when
 *  the recipient tries to use it. */
function assertResourceExists(
  resource_type: GrantResourceType,
  resource_id: string,
): void {
  switch (resource_type) {
    case "workspace": {
      if (!getWorkspace(resource_id)) {
        throw new Error("Resource not found: workspace");
      }
      return;
    }
    case "conversation": {
      if (!getConversation(resource_id)) {
        throw new Error("Resource not found: conversation");
      }
      return;
    }
    case "task": {
      if (!getTask(resource_id)) {
        throw new Error("Resource not found: task");
      }
      return;
    }
    case "file": {
      // resource_id format: "<workspace_id>:<path>". We don't probe for
      // file existence — files come and go through patches, and the grant
      // should survive a temporary rename. We just sanity-check the
      // workspace half.
      const wsId = resource_id.split(":", 1)[0];
      if (!wsId || !getWorkspace(wsId)) {
        throw new Error("Resource not found: file's parent workspace");
      }
      return;
    }
  }
}

/**
 * A grant delegates access. You can only delegate access you actually hold:
 * verify the granting agent's own authority over the resource before minting.
 * Without this, any two agents (or one user with a throwaway second account)
 * could grant each other write/admin on ANY workspace/conversation/task by id,
 * bypassing the access model entirely. The handoff path satisfies this because
 * the proposer is validated as a conversation member and workspace writer.
 */
function assertGranterAuthority(input: CreateGrantInput): void {
  const wantsWrite = input.scopes.some((s) => s === "write" || s === "admin");
  switch (input.resource_type) {
    case "workspace": {
      const ok = wantsWrite
        ? canWrite(input.resource_id, input.from_agent_id)
        : canRead(input.resource_id, input.from_agent_id);
      if (!ok) {
        throw new Error("Cannot grant access you don't hold on this workspace.");
      }
      // If the workspace is bound to a conversation, the granter must be a
      // member of it — otherwise a direct grant could hand out access to a
      // workspace across conversation boundaries (the handoff path enforces the
      // same binding via proposeHandoff).
      const ws = getWorkspace(input.resource_id);
      if (
        ws?.conversation_id &&
        !listMembers(ws.conversation_id).some((m) => m.agent_id === input.from_agent_id)
      ) {
        throw new Error(
          "Cannot grant access to a workspace bound to a conversation you're not in.",
        );
      }
      return;
    }
    case "file": {
      const wsId = input.resource_id.split(":", 1)[0];
      const ok = wantsWrite
        ? canWrite(wsId, input.from_agent_id)
        : canRead(wsId, input.from_agent_id);
      if (!ok) {
        throw new Error("Cannot grant access you don't hold on this file's workspace.");
      }
      return;
    }
    case "conversation": {
      const isMember = listMembers(input.resource_id).some(
        (m) => m.agent_id === input.from_agent_id,
      );
      if (!isMember) {
        throw new Error("Cannot grant access to a conversation you're not a member of.");
      }
      return;
    }
    case "task": {
      const t = getTask(input.resource_id);
      if (!t) throw new Error("Resource not found: task");
      const ownerOrAssignee =
        t.owner_agent_id === input.from_agent_id ||
        t.assigned_to_agent_id === input.from_agent_id;
      const convMember =
        !!t.conversation_id &&
        listMembers(t.conversation_id).some(
          (m) => m.agent_id === input.from_agent_id,
        );
      if (!ownerOrAssignee && !convMember) {
        throw new Error("Cannot grant access to a task you don't own or collaborate on.");
      }
      return;
    }
  }
}

export type CreateGrantInput = {
  from_user_id: string;
  from_agent_id: string;
  to_agent_id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  scopes: GrantScope[];
  duration_key?: string;
  expires_at?: number | null;
  handoff_id?: string | null;
};

export function createGrant(input: CreateGrantInput): SharedGrant {
  if (!isValidResourceType(input.resource_type)) {
    throw new Error(`Unsupported resource_type "${input.resource_type}".`);
  }
  if (!input.scopes.every(isValidScope)) {
    throw new Error("scopes must be a subset of " + ALL_SCOPES.join("/"));
  }
  if (input.scopes.length === 0) {
    throw new Error("Grant must have at least one scope.");
  }
  const fromAgent = getAgent(input.from_agent_id);
  if (!fromAgent) throw new Error("Granting agent not found.");
  if (fromAgent.owner_user_id !== input.from_user_id) {
    throw new Error("Not your agent — cannot grant on its behalf.");
  }
  const toAgent = getAgent(input.to_agent_id);
  if (!toAgent) throw new Error("Recipient agent not found.");
  if (toAgent.owner_user_id === input.from_user_id) {
    throw new Error("No grant needed — you already own that agent.");
  }
  assertResourceExists(input.resource_type, input.resource_id);
  assertGranterAuthority(input);

  const now = Date.now();
  let expires: number | null = input.expires_at ?? null;
  if (input.duration_key && !input.expires_at) {
    const preset = DURATION_PRESETS.find((d) => d.key === input.duration_key);
    if (!preset) throw new Error(`Unknown duration preset: ${input.duration_key}.`);
    expires = preset.ms === null ? null : now + preset.ms;
  }
  // Dedup scopes; the canonicalizer also sorts, so two equivalent grants
  // produce identical signatures.
  const scopes = Array.from(new Set(input.scopes));

  const id = newGrantId();
  const signature = signGrantPayload(
    canonicalPayload({
      id,
      from_agent_id: fromAgent.id,
      to_agent_id: toAgent.id,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      scopes,
      expires_at: expires,
      created_at: now,
    }),
  );

  db()
    .prepare(
      `INSERT INTO shared_grants
       (id, from_agent_id, from_user_id, to_agent_id, to_user_id,
        resource_type, resource_id, scopes_json, handoff_id,
        signature, expires_at, revoked_at, revoked_reason,
        last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      id,
      fromAgent.id,
      input.from_user_id,
      toAgent.id,
      toAgent.owner_user_id,
      input.resource_type,
      input.resource_id,
      JSON.stringify(scopes),
      input.handoff_id ?? null,
      signature,
      expires,
      now,
    );

  logAudit("grant.create", {
    userId: input.from_user_id,
    agentId: fromAgent.id,
    detail: {
      grant_id: id,
      to_agent: toAgent.id,
      to_user: toAgent.owner_user_id,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      scopes,
      expires_at: expires,
      handoff_id: input.handoff_id ?? null,
    },
  });
  return getGrant(id)!;
}

export function getGrant(id: string): SharedGrant | null {
  return (
    (db()
      .prepare(`SELECT ${GRANT_COLUMNS} FROM shared_grants WHERE id = ?`)
      .get(id) as SharedGrant | undefined) ?? null
  );
}

export function parseGrantScopes(g: SharedGrant): GrantScope[] {
  try {
    const v = JSON.parse(g.scopes_json) as unknown[];
    if (!Array.isArray(v)) return [];
    return v.filter(isValidScope);
  } catch {
    return [];
  }
}

/** Active = not revoked AND not expired. */
export function isGrantActive(g: SharedGrant, now = Date.now()): boolean {
  if (g.revoked_at !== null) return false;
  if (g.expires_at !== null && g.expires_at <= now) return false;
  return true;
}

/** Verify a grant the way the recipient would use it. Returns true only
 *  when the row exists, the signature still matches the payload, and the
 *  grant is active. Logs an audit event on use so the granter can see
 *  who's actually leveraging the share. */
export function verifyGrantForUse(input: {
  grant_id: string;
  using_agent_id: string;
  required_scope: GrantScope;
}): { ok: true; grant: SharedGrant } | { ok: false; reason: string } {
  const g = getGrant(input.grant_id);
  if (!g) return { ok: false, reason: "grant not found" };
  if (g.to_agent_id !== input.using_agent_id) {
    return { ok: false, reason: "grant is not for this agent" };
  }
  if (!isGrantActive(g)) {
    return {
      ok: false,
      reason:
        g.revoked_at !== null
          ? `grant revoked${g.revoked_reason ? `: ${g.revoked_reason}` : ""}`
          : "grant expired",
    };
  }
  const scopes = parseGrantScopes(g);
  if (!scopes.includes(input.required_scope) && !scopes.includes("admin")) {
    return {
      ok: false,
      reason: `grant does not include "${input.required_scope}" scope`,
    };
  }
  // Signature check protects against direct DB tampering (someone editing
  // shared_grants.scopes_json to escalate). With the row's own signature
  // recomputed from its fields, any field mutation flips this to false.
  const payload = canonicalPayload({
    id: g.id,
    from_agent_id: g.from_agent_id,
    to_agent_id: g.to_agent_id,
    resource_type: g.resource_type as GrantResourceType,
    resource_id: g.resource_id,
    scopes,
    expires_at: g.expires_at,
    created_at: g.created_at,
  });
  if (!verifyGrantSignature(payload, g.signature)) {
    return { ok: false, reason: "signature mismatch (grant was tampered with)" };
  }
  // Best-effort last-used stamp. Don't fail the verification if the
  // write loses a race; the read above already proved the grant.
  try {
    db()
      .prepare("UPDATE shared_grants SET last_used_at = ? WHERE id = ?")
      .run(Date.now(), g.id);
  } catch {
    /* ignore */
  }
  return { ok: true, grant: g };
}

// ---------------------------------------------------------------------------
// Enforcement — the bridge from "grants exist" to "grants do something".
//
// These are the functions call sites use to actually gate a read/write. Until
// they were wired in (tool dispatch, REST patch/read paths), a grant was a
// signed-but-inert row: a co-edit handoff minted a `write` grant that nothing
// consulted, while the recipient's reader subscription blocked the write. Now
// the grant is the authority — and revoking it cuts the access it conferred.
// ---------------------------------------------------------------------------

/** Find an active, signature-valid grant authorizing `using_agent_id` to use
 *  `required_scope` on a specific resource. Reuses verifyGrantForUse (scope +
 *  signature + active + last_used stamp). Returns the grant, or null. */
export function findUsableGrant(input: {
  using_agent_id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  required_scope: GrantScope;
}): SharedGrant | null {
  for (const g of listGrantsToAgent(input.using_agent_id)) {
    if (g.resource_type !== input.resource_type) continue;
    if (g.resource_id !== input.resource_id) continue;
    const res = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: input.using_agent_id,
      required_scope: input.required_scope,
    });
    if (res.ok) return res.grant;
  }
  return null;
}

/** Enforcement helper for call sites (tool dispatch, REST write/read paths):
 *  true iff the agent holds a usable grant for (resource, scope). Audits the
 *  successful use so the granter can see who is actually leveraging the share. */
export function agentMayUseResource(input: {
  using_agent_id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  required_scope: GrantScope;
}): boolean {
  const g = findUsableGrant(input);
  if (!g) return false;
  logAudit("grant.use", {
    agentId: input.using_agent_id,
    detail: {
      grant_id: g.id,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      scope: input.required_scope,
    },
  });
  return true;
}

/** Revoke every active grant minted for a handoff. Used when the handoff is
 *  completed (collaboration wound down) so scoped access doesn't linger past
 *  the work — the symmetric inverse of createGrantsForHandoff. Returns the
 *  number of grants revoked. */
export function revokeGrantsForHandoff(input: {
  handoff_id: string;
  user_id: string;
  reason?: string;
}): number {
  const rows = db()
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM shared_grants
       WHERE handoff_id = ? AND revoked_at IS NULL`,
    )
    .all(input.handoff_id) as SharedGrant[];
  if (rows.length === 0) return 0;
  const reason = (input.reason ?? "handoff ended").slice(0, 280);
  const now = Date.now();
  const stmt = db().prepare(
    `UPDATE shared_grants SET revoked_at = ?, revoked_reason = ?
     WHERE id = ? AND revoked_at IS NULL`,
  );
  let n = 0;
  for (const g of rows) {
    if (stmt.run(now, reason, g.id).changes > 0) n += 1;
  }
  if (n > 0) {
    logAudit("grant.revoke_cascade", {
      userId: input.user_id,
      detail: { handoff_id: input.handoff_id, revoked: n, reason },
    });
  }
  return n;
}

export type RevokeGrantInput = {
  grant_id: string;
  user_id: string;
  reason?: string;
};

export function revokeGrant(input: RevokeGrantInput): SharedGrant {
  const g = getGrant(input.grant_id);
  if (!g) throw new Error("grant not found");
  // Both sides can revoke: the granter (obvious), and the recipient
  // (if they want to drop a permission they no longer need). Keeps the
  // model symmetric and reduces "stuck" grants.
  if (g.from_user_id !== input.user_id && g.to_user_id !== input.user_id) {
    throw new Error("Only the granter or the recipient can revoke.");
  }
  if (g.revoked_at !== null) return g;
  const reason = (input.reason ?? "").slice(0, 280);
  db()
    .prepare(
      `UPDATE shared_grants SET revoked_at = ?, revoked_reason = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(Date.now(), reason, g.id);
  logAudit("grant.revoke", {
    userId: input.user_id,
    detail: {
      grant_id: g.id,
      side: g.from_user_id === input.user_id ? "granter" : "recipient",
      reason,
    },
  });
  return getGrant(g.id)!;
}

export function listGrantsFromUser(
  userId: string,
  opts: { include_revoked?: boolean; limit?: number } = {},
): SharedGrant[] {
  const limit = opts.limit ?? 100;
  if (opts.include_revoked) {
    return db()
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM shared_grants
         WHERE from_user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as SharedGrant[];
  }
  return db()
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM shared_grants
       WHERE from_user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as SharedGrant[];
}

export function listGrantsToAgent(agentId: string, limit = 100): SharedGrant[] {
  return db()
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM shared_grants
       WHERE to_agent_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as SharedGrant[];
}

/** Grants RECEIVED by a user — the inbound side of the Access layer: what this
 *  user's agents can reach on other people's resources. Mirror of
 *  listGrantsFromUser so the UI can show both directions of delegation. */
export function listGrantsToUser(
  userId: string,
  opts: { include_revoked?: boolean; limit?: number } = {},
): SharedGrant[] {
  const limit = opts.limit ?? 100;
  if (opts.include_revoked) {
    return db()
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM shared_grants
         WHERE to_user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as SharedGrant[];
  }
  return db()
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM shared_grants
       WHERE to_user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as SharedGrant[];
}

/** Convenience used by handoff acceptance — create one grant per
 *  attached resource. Returns the grants in creation order so the caller
 *  can link them on the handoff row or surface them in the success
 *  notification. */
export function createGrantsForHandoff(input: {
  handoff_id: string;
  from_user_id: string;
  from_agent_id: string;
  to_agent_id: string;
  workspace_id?: string | null;
  conversation_id: string;
  scopes: GrantScope[];
  duration_key?: string;
}): SharedGrant[] {
  const out: SharedGrant[] = [];
  // Conversation grant — always issued because the recipient agent needs
  // to read the chat to do anything useful.
  out.push(
    createGrant({
      from_user_id: input.from_user_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      resource_type: "conversation",
      resource_id: input.conversation_id,
      scopes: input.scopes.includes("write") ? ["read", "comment"] : ["read"],
      duration_key: input.duration_key,
      handoff_id: input.handoff_id,
    }),
  );
  if (input.workspace_id) {
    out.push(
      createGrant({
        from_user_id: input.from_user_id,
        from_agent_id: input.from_agent_id,
        to_agent_id: input.to_agent_id,
        resource_type: "workspace",
        resource_id: input.workspace_id,
        scopes: input.scopes,
        duration_key: input.duration_key,
        handoff_id: input.handoff_id,
      }),
    );
  }
  return out;
}
