// Web-end (real HTTP) E2E against the LIVE dev server. Seeds identities into
// the same data/a2a.db the server uses, then drives the fix-critical multi-party
// flows through the actual /api/v1 routes with real Bearer auth — validating the
// fixes end-to-end through the Next.js server stack, not in-process.
//
// Prereq: `npm run dev` running on :3000.
// Run: node --env-file=.env.local --import tsx scripts/web-e2e.ts
import { db } from "../lib/db";
import { createAgentForUser, setAgentCapabilities } from "../lib/agents";
import { hashPassword } from "../lib/crypto";
import { createWorkspace, applyPatch, subscribeAgent, getWorkspace } from "../lib/workspaces";
import { newConversationId } from "../lib/ids";

const BASE = process.env.WEB_E2E_BASE ?? "http://localhost:3000";

type Row = { name: string; ok: boolean; detail: string };
const results: Row[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok " : "ANOM"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function api(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

const RUN = Date.now().toString(36).slice(-5); // unique per run so re-runs don't collide
let U = 0;
function user(handle: string): string {
  const uid = `u_web_${RUN}_${handle}_${U++}`;
  db()
    .prepare(
      "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(uid, `${handle}-${RUN}-${U}@web.test`, handle, "x".repeat(128), "y".repeat(32), Date.now());
  return uid;
}
function agent(handle: string, caps: string[] = []) {
  const uid = user(handle);
  const { agent: a, apiKey } = createAgentForUser(uid, { handle: `${handle}${RUN}`, display_name: handle });
  if (caps.length) setAgentCapabilities(a.id, uid, caps.map((name) => ({ name, version: "1" })));
  return { uid, id: a.id, key: apiKey };
}
// The review participants are seeded under a single loggable per-run user so
// the resulting task is viewable in the browser as that human.
const DEMO_UID = `usr_webdemo_${RUN}`;
const DEMO_EMAIL = `webdemo-${RUN}@demo.app`;
const DEMO_PW = "Passw0rd-Tester!";
let demoUserSeeded = false;
function qwenAgent(handle: string, caps: string[] = []) {
  if (!demoUserSeeded) {
    const { hash, salt } = hashPassword(DEMO_PW);
    db()
      .prepare(
        "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(DEMO_UID, DEMO_EMAIL, "Web Demo", hash, salt, Date.now());
    demoUserSeeded = true;
  }
  const { agent: a, apiKey } = createAgentForUser(DEMO_UID, {
    handle: `${handle}${RUN}`,
    display_name: handle,
  });
  if (caps.length) setAgentCapabilities(a.id, DEMO_UID, caps.map((name) => ({ name, version: "1" })));
  return { uid: DEMO_UID, id: a.id, key: apiKey };
}
function group(creatorId: string, title: string, memberIds: string[]): string {
  const id = newConversationId();
  db()
    .prepare("INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)")
    .run(id, "group", title, creatorId, Date.now());
  for (const m of memberIds)
    db()
      .prepare("INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)")
      .run(id, m, "member", Date.now());
  return id;
}

void (async () => {
  // --- preflight: server up? -------------------------------------------------
  try {
    const ping = await fetch(`${BASE}/api/v1/tools`, { headers: { authorization: "Bearer x" } });
    if (ping.status === 0) throw new Error("no response");
  } catch (e) {
    console.error(`Server not reachable at ${BASE}. Start it with: npm run dev`);
    process.exit(2);
  }

  // --- seed identities + a review-gated task in a shared workspace -----------
  const owner = qwenAgent("owner", ["workspace.write"]);
  const rev1 = qwenAgent("rev1", ["task.review", "market.feasibility"]);
  const rev2 = qwenAgent("rev2", ["task.review", "market.feasibility"]);
  const outsider = agent("outsider", []); // cross-user, for the grant test
  const conv = group(owner.id, "Web E2E — multi-approver", [owner.id, rev1.id, rev2.id]);
  const ws = createWorkspace({ name: "web-ws", conversation_id: conv, created_by_agent_id: owner.id });
  subscribeAgent(ws.id, rev1.id, "reader");
  subscribeAgent(ws.id, rev2.id, "reader");
  // owner commits a check.sh (passes) + a result, so the review-gated task has a snapshot.
  const seed = applyPatch({
    workspace_id: ws.id,
    agent_id: owner.id,
    against_rev: getWorkspace(ws.id)!.head_snapshot_id!,
    ops: [
      { path: "check.sh", op: "create", content: "exit 0\n" },
      { path: "deliverable.txt", op: "create", content: "v1\n" },
    ],
  });
  if (!seed.ok) throw new Error("seed patch failed");
  console.log(`[seed] conv=${conv} ws=${ws.id} owner=${owner.id} rev1=${rev1.id} rev2=${rev2.id}`);

  // =========================================================================
  // FLOW 1 — multi-approver review (min_approvers=2) THROUGH THE HTTP API
  //   validates the multi-approver fix + transition CAS via the real routes.
  // =========================================================================
  const createTaskRes = await api("POST", "/api/v1/tasks", owner.key, {
    title: "Web multi-approver task",
    conversation_id: conv,
    workspace_id: ws.id,
    required_capabilities: ["workspace.write"],
    success_criteria: [
      { type: "test_command", cmd: "bash check.sh" },
      { type: "diff_review", min_approvers: 2, approver_capability: "market.feasibility" },
    ],
  });
  const taskId = createTaskRes.json?.task?.id ?? createTaskRes.json?.id;
  check("POST /tasks creates a review-gated task", createTaskRes.status < 300 && !!taskId, `status=${createTaskRes.status} id=${taskId}`);

  // owner assigns to self, moves through in_progress → awaiting_review with the result snapshot
  await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { assigned_to_agent_id: owner.id });
  await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { status: "in_progress" });
  const toReview = await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, {
    status: "awaiting_review",
    result_snapshot_id: getWorkspace(ws.id)!.head_snapshot_id,
  });
  check("PATCH → awaiting_review via HTTP", toReview.status === 200, `status=${toReview.status}`);

  // assignee (owner) cannot approve own work — HTTP must reject
  const selfApprove = await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { action: "approve" });
  check("assignee self-approve rejected over HTTP", selfApprove.status >= 400, `status=${selfApprove.status}`);

  // reviewer 1 approves via HTTP
  const a1 = await api("PATCH", `/api/v1/tasks/${taskId}`, rev1.key, { action: "approve" });
  check("rev1 approve via HTTP", a1.status === 200, `status=${a1.status}`);

  // with only 1/2 approvals, closing must NOT reach done
  const close1 = await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { status: "done" });
  const status1 = (await api("GET", `/api/v1/tasks/${taskId}`, owner.key)).json?.task?.status;
  check("1/2 approvals does NOT reach done over HTTP", status1 !== "done", `status=${status1}`);

  // reviewer 2 approves; re-submit to awaiting_review if it bounced, then close
  let cur = (await api("GET", `/api/v1/tasks/${taskId}`, owner.key)).json?.task?.status;
  if (cur === "changes_requested") {
    await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { status: "in_progress" });
    await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, {
      status: "awaiting_review",
      result_snapshot_id: getWorkspace(ws.id)!.head_snapshot_id,
    });
  }
  const a2 = await api("PATCH", `/api/v1/tasks/${taskId}`, rev2.key, { action: "approve" });
  const close2 = await api("PATCH", `/api/v1/tasks/${taskId}`, owner.key, { status: "done" });
  const finalStatus = (await api("GET", `/api/v1/tasks/${taskId}`, owner.key)).json?.task?.status;
  check("2/2 approvers reach done over HTTP", finalStatus === "done", `rev2=${a2.status} close=${close2.status} final=${finalStatus}`);

  // =========================================================================
  // FLOW 2 — grant enforcement THROUGH THE FILE GET ROUTE
  // =========================================================================
  const noGrant = await api("GET", `/api/v1/workspaces/${ws.id}/files/deliverable.txt`, outsider.key);
  check("outsider without grant → 403 on file read", noGrant.status === 403, `status=${noGrant.status}`);

  const grantRes = await api("POST", "/api/v1/grants", owner.key, {
    to_agent_id: outsider.id,
    resource_type: "workspace",
    resource_id: ws.id,
    scopes: ["read"],
    duration_key: "1h",
  });
  const grantId = grantRes.json?.grant?.id ?? grantRes.json?.id;
  check("POST /grants mints a read grant", grantRes.status < 300 && !!grantId, `status=${grantRes.status} id=${grantId}`);

  const withGrant = await api("GET", `/api/v1/workspaces/${ws.id}/files/deliverable.txt`, outsider.key);
  check("outsider WITH read grant → 200 on file read", withGrant.status === 200, `status=${withGrant.status}`);

  if (grantId) {
    await api("DELETE", `/api/v1/grants/${grantId}`, owner.key);
    const revoked = await api("GET", `/api/v1/workspaces/${ws.id}/files/deliverable.txt`, outsider.key);
    check("after revoke → 403 again", revoked.status === 403, `status=${revoked.status}`);
  }

  // =========================================================================
  // FLOW 3 — concurrent patches THROUGH /patches (auto-rebase + same-path 409)
  // =========================================================================
  const head = getWorkspace(ws.id)!.head_snapshot_id!;
  const [pA, pB] = await Promise.all([
    api("POST", `/api/v1/workspaces/${ws.id}/patches`, owner.key, {
      against_rev: head,
      files: [{ path: "fileA.txt", op: "create", content: "A\n" }],
    }),
    api("POST", `/api/v1/workspaces/${ws.id}/patches`, owner.key, {
      against_rev: head,
      files: [{ path: "fileB.txt", op: "create", content: "B\n" }],
    }),
  ]);
  check("concurrent different-file patches both succeed (auto-rebase)", pA.status === 200 && pB.status === 200, `A=${pA.status} B=${pB.status}`);

  const head2 = getWorkspace(ws.id)!.head_snapshot_id!;
  const [cA, cB] = await Promise.all([
    api("POST", `/api/v1/workspaces/${ws.id}/patches`, owner.key, {
      against_rev: head2,
      files: [{ path: "clash.txt", op: "create", content: "fromA\n" }],
    }),
    api("POST", `/api/v1/workspaces/${ws.id}/patches`, owner.key, {
      against_rev: head2,
      files: [{ path: "clash.txt", op: "create", content: "fromB\n" }],
    }),
  ]);
  const oks = [cA, cB].filter((r) => r.status === 200).length;
  const conflicts = [cA, cB].filter((r) => r.status === 409 || r.json?.error === "conflict").length;
  check("concurrent same-path patches → exactly one wins", oks === 1 && conflicts === 1, `A=${cA.status} B=${cB.status}`);

  // =========================================================================
  // FLOW 4 — cross-workspace IDOR via against_rev rejected over HTTP
  // =========================================================================
  const ws2 = createWorkspace({ name: "web-ws2", conversation_id: conv, created_by_agent_id: owner.id });
  const foreignHead = getWorkspace(ws2.id)!.head_snapshot_id!;
  const idor = await api("POST", `/api/v1/workspaces/${ws.id}/patches`, owner.key, {
    against_rev: foreignHead, // a snapshot from ws2, used against ws
    files: [{ path: "x.txt", op: "create", content: "x\n" }],
  });
  check("cross-workspace against_rev rejected over HTTP (IDOR)", idor.status >= 400, `status=${idor.status} err=${idor.json?.error}`);

  // --- summary --------------------------------------------------------------
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n================ WEB E2E SUMMARY ================`);
  console.log(`flows: ${results.length}  pass: ${pass}  anomalies: ${results.length - pass}`);
  console.log(`task=${taskId} conv=${conv} ws=${ws.id}`);
  console.log(`BROWSER LOGIN: ${DEMO_EMAIL} / ${DEMO_PW}  → /app/c/${conv}/tasks/${taskId}`);
  if (pass !== results.length) {
    console.log("ANOMALIES:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name} — ${r.detail}`);
    process.exit(1);
  }
  console.log("all web flows passed");
})();
