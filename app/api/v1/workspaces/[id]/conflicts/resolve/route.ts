import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { applyPatch, canWrite, getWorkspace, type FileOp } from "@/lib/workspaces";
import { agentMayUseResource } from "@/lib/grants";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Programmatic conflict resolution for a local agent that hit a 409 from
// POST /patches. Without this an agent has no REST path past a same-line
// conflict (only the web /resolve page) — the blocker for autonomous
// co-editing. Per conflicting path the caller chooses:
//   - "theirs"        → keep the current head's version (drop my change)
//   - "mine"|"merged" → write the content I provide (my version / hand-merge)
// All "mine"/"merged" paths apply as one patch against `against_rev` (the head
// you resolved from); applyPatch's IMMEDIATE-tx head re-read still guards a
// racing third write (you'd get another 409 to resolve again).

type Resolution =
  | { path: string; choice: "theirs" }
  | { path: string; choice: "mine" | "merged"; content?: string; base64?: string };

type Body = {
  against_rev?: string;
  commit_message?: string;
  resolutions?: Resolution[];
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "ws.resolve"),
    RATE_LIMITS.apiWorkspacePatch,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return jsonError(404, "Workspace not found.");
  if (
    !canWrite(ws.id, auth.agent.id) &&
    !agentMayUseResource({
      using_agent_id: auth.agent.id,
      resource_type: "workspace",
      resource_id: ws.id,
      required_scope: "write",
    })
  ) {
    return jsonError(403, "Writer/admin role or a write grant is required.");
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.against_rev) return jsonError(400, "against_rev is required.");
  if (!body.resolutions || body.resolutions.length === 0) {
    return jsonError(400, "resolutions[] is required.");
  }

  const ops: FileOp[] = [];
  const decisions: Array<{ path: string; choice: string }> = [];
  for (const r of body.resolutions) {
    if (!r || typeof r.path !== "string" || !r.path) {
      return jsonError(400, "each resolution needs a path.");
    }
    if (r.choice === "theirs") {
      // Keep head's version: contribute no op for this path.
      decisions.push({ path: r.path, choice: "theirs" });
      continue;
    }
    if (r.choice === "mine" || r.choice === "merged") {
      let buf: Buffer;
      if (typeof r.base64 === "string") {
        try {
          buf = Buffer.from(r.base64, "base64");
        } catch {
          return jsonError(400, `bad base64 for ${r.path}`);
        }
      } else if (typeof r.content === "string") {
        buf = Buffer.from(r.content, "utf8");
      } else {
        return jsonError(400, `resolution "${r.choice}" for ${r.path} needs content or base64.`);
      }
      ops.push({ path: r.path, op: "modify", content: buf });
      decisions.push({ path: r.path, choice: r.choice });
      continue;
    }
    return jsonError(400, `unknown choice for ${r.path} (use mine|theirs|merged).`);
  }

  // All "theirs" → nothing to write; head already holds the resolved state.
  if (ops.length === 0) {
    return jsonOk({
      resolved: true,
      snapshot_id: ws.head_snapshot_id,
      changed: [],
      decisions,
    });
  }

  let result;
  try {
    result = applyPatch({
      workspace_id: ws.id,
      agent_id: auth.agent.id,
      against_rev: body.against_rev,
      ops,
      commit_message: body.commit_message || "resolve conflict",
    });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Resolve failed.");
  }
  if (!result.ok) {
    // Head moved again while resolving — surface a fresh conflict to retry.
    return new Response(
      JSON.stringify({
        error: "conflict",
        current_head: result.current_head,
        your_against_rev: result.your_against_rev,
        conflicting_paths: result.conflicting_paths,
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  return jsonOk({
    resolved: true,
    snapshot_id: result.snapshot_id,
    parent_snapshot_id: result.parent_snapshot_id,
    changed: result.changed,
    decisions,
  });
}
