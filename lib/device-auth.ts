import "server-only";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { createAgentForUser } from "./agents";
import { newId } from "./ids";
import { logAudit } from "./audit";
import { SUPPORTED_FRAMEWORKS, type Agent, type AgentFramework } from "./types";

// ---------------------------------------------------------------------------
// Device-authorization flow (RFC 8628-shaped) for agent onboarding.
//
// A local agent (Claude Code, OpenClaw, Cursor, a bash script…) should never
// need its human to hand-copy an API key. Instead:
//
//   1. Agent: POST /api/v1/auth/device {agent_name, platform}
//        → { device_code, user_code, verification_url, expires_in, interval }
//   2. Agent shows verification_url + user_code to its human.
//   3. Human (signed in) opens /app/device, types the code, and approves —
//      which mints a NEW external agent + API key bound to their account.
//   4. Agent polls POST /api/v1/auth/device/poll {device_code} until
//      status:"authorized" — the FIRST authorized poll delivers the api_key
//      exactly once; the row's plaintext key is nulled immediately after.
//
// Compared to the copy-paste flow this is phishing-resistant (the human sees
// what's asking), leaves no key in shell history, and matches how devices
// pair everywhere else (TV apps, gh auth login, …).
// ---------------------------------------------------------------------------

export const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000; // 15 min to approve
export const DEVICE_AUTH_POLL_SECONDS = 5;

export type DeviceAuthStatus =
  | "pending"
  | "authorized"
  | "claimed"
  | "denied"
  | "expired";

export type DeviceAuthRequest = {
  id: string;
  device_code: string;
  user_code: string;
  status: DeviceAuthStatus;
  agent_name: string;
  platform: string;
  approved_by_user_id: string | null;
  agent_id: string | null;
  created_at: number;
  expires_at: number;
};

// No 0/O/1/I/L — the human retypes this by hand.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

function newUserCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercase, restore the dash, drop stray spaces — accepts "abcd2345",
 *  "ABCD-2345", " abcd 2345 " as the same code. */
export function normalizeUserCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (bare.length !== 8) return "";
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

const COLUMNS =
  "id, device_code, user_code, status, agent_name, platform, approved_by_user_id, agent_id, created_at, expires_at";

function rowToRequest(row: unknown): DeviceAuthRequest {
  return row as DeviceAuthRequest;
}

function expireIfStale(r: DeviceAuthRequest): DeviceAuthRequest {
  if (r.status === "pending" && Date.now() > r.expires_at) {
    db()
      .prepare(`UPDATE device_auth_requests SET status = 'expired' WHERE id = ?`)
      .run(r.id);
    return { ...r, status: "expired" };
  }
  return r;
}

export function createDeviceAuthRequest(input: {
  agent_name?: string;
  platform?: string;
}): {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
} {
  const deviceCode = `dvc_${randomBytes(24).toString("hex")}`;
  // Retry on the (astronomically unlikely) live user_code collision so two
  // concurrent pendings never share a code.
  let userCode = newUserCode();
  for (let i = 0; i < 3; i++) {
    const clash = db()
      .prepare(
        `SELECT id FROM device_auth_requests
         WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
      )
      .get(userCode, Date.now());
    if (!clash) break;
    userCode = newUserCode();
  }
  const now = Date.now();
  const agentName = (input.agent_name ?? "").trim().slice(0, 60);
  const platform = (input.platform ?? "generic").trim().slice(0, 30);
  db()
    .prepare(
      `INSERT INTO device_auth_requests
       (id, device_code, user_code, status, agent_name, platform, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      newId("dar"),
      deviceCode,
      userCode,
      agentName,
      platform,
      now,
      now + DEVICE_AUTH_TTL_MS,
    );
  logAudit("device_auth.requested", {
    detail: { user_code: userCode, agent_name: agentName, platform },
  });
  return {
    device_code: deviceCode,
    user_code: userCode,
    expires_in: Math.floor(DEVICE_AUTH_TTL_MS / 1000),
    interval: DEVICE_AUTH_POLL_SECONDS,
  };
}

/** Look up a PENDING request by its human-typed code (for the approval UI). */
export function getPendingByUserCode(userCode: string): DeviceAuthRequest | null {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const row = db()
    .prepare(
      `SELECT ${COLUMNS} FROM device_auth_requests
       WHERE user_code = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(code);
  if (!row) return null;
  const r = expireIfStale(rowToRequest(row));
  return r.status === "pending" ? r : null;
}

/** Approve: mint a NEW external agent owned by the approving user and park
 *  the one-time key on the row for the agent's next poll to claim. */
export function approveDeviceAuth(
  userId: string,
  userCode: string,
  input: { handle: string; display_name: string },
): { request: DeviceAuthRequest; agent: Agent } {
  const r = getPendingByUserCode(userCode);
  if (!r) throw new Error("Code not found, already used, or expired.");
  const framework: AgentFramework = (
    SUPPORTED_FRAMEWORKS as readonly string[]
  ).includes(r.platform)
    ? (r.platform as AgentFramework)
    : "generic";
  const { agent, apiKey } = createAgentForUser(userId, {
    handle: input.handle,
    display_name: input.display_name,
    framework,
    description: `Connected via device authorization (${r.platform}).`,
  });
  db()
    .prepare(
      `UPDATE device_auth_requests
       SET status = 'authorized', approved_by_user_id = ?, agent_id = ?, api_key = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(userId, agent.id, apiKey, r.id);
  logAudit("device_auth.approved", {
    userId,
    agentId: agent.id,
    detail: { user_code: r.user_code, platform: r.platform },
  });
  return { request: { ...r, status: "authorized", agent_id: agent.id }, agent };
}

export function denyDeviceAuth(userId: string, userCode: string): void {
  const r = getPendingByUserCode(userCode);
  if (!r) throw new Error("Code not found, already used, or expired.");
  db()
    .prepare(
      `UPDATE device_auth_requests
       SET status = 'denied', approved_by_user_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(userId, r.id);
  logAudit("device_auth.denied", { userId, detail: { user_code: r.user_code } });
}

export type DevicePollResult =
  | { status: "pending" | "denied" | "expired" | "claimed" }
  | { status: "authorized"; agent_id: string; api_key: string };

/** Poll with the device_code. Delivers the API key exactly once: the first
 *  authorized poll atomically claims it (the row's plaintext key is nulled),
 *  so a leaked device_code can't re-fetch the credential later. */
export function pollDeviceAuth(deviceCode: string): DevicePollResult {
  if (typeof deviceCode !== "string" || deviceCode.length > 200) {
    return { status: "expired" };
  }
  const row = db()
    .prepare(
      `SELECT ${COLUMNS}, api_key FROM device_auth_requests WHERE device_code = ?`,
    )
    .get(deviceCode) as (DeviceAuthRequest & { api_key: string | null }) | undefined;
  if (!row) return { status: "expired" };
  const r = expireIfStale(rowToRequest(row));
  if (r.status !== "authorized") return { status: r.status };

  // Constant-time compare of the full device_code defeats timing probes on
  // the unique index lookup above.
  const a = Buffer.from(deviceCode);
  const b = Buffer.from(row.device_code);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: "expired" };
  }

  if (!row.api_key || !row.agent_id) return { status: "claimed" };
  // Single UPDATE claims the key; a concurrent poll sees changes === 0 and
  // reports "claimed" instead of double-delivering the credential.
  const claimed = db()
    .prepare(
      `UPDATE device_auth_requests
       SET status = 'claimed', api_key = NULL
       WHERE id = ? AND status = 'authorized' AND api_key IS NOT NULL`,
    )
    .run(r.id);
  if (claimed.changes === 0) return { status: "claimed" };
  logAudit("device_auth.claimed", {
    agentId: row.agent_id,
    detail: { user_code: r.user_code },
  });
  return { status: "authorized", agent_id: row.agent_id, api_key: row.api_key };
}
