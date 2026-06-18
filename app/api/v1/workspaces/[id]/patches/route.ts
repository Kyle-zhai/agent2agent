import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  applyPatch,
  canWrite,
  getWorkspace,
  type FileOp,
} from "@/lib/workspaces";
import { agentMayUseResource } from "@/lib/grants";
import { addTaskArtifact, getTask } from "@/lib/tasks";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type PatchBody = {
  against_rev?: string;
  commit_message?: string;
  thinking?: string;
  task_id?: string | null;
  files?: Array<
    | { path: string; op: "create" | "modify"; content?: string; base64?: string }
    | { path: string; op: "delete" }
  >;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "ws.patch"),
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

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.against_rev) {
    return jsonError(400, "against_rev is required.");
  }
  if (!body.files || body.files.length === 0) {
    return jsonError(400, "files[] is required.");
  }
  if (body.task_id) {
    const t = getTask(body.task_id);
    if (!t) return jsonError(404, "task_id not found.");
    if (t.workspace_id && t.workspace_id !== ws.id) {
      return jsonError(400, "task is bound to a different workspace.");
    }
  }

  const ops: FileOp[] = [];
  for (const f of body.files) {
    if (f.op === "delete") {
      ops.push({ path: f.path, op: "delete" });
      continue;
    }
    let buf: Buffer;
    if ("base64" in f && typeof f.base64 === "string") {
      try {
        buf = Buffer.from(f.base64, "base64");
      } catch {
        return jsonError(400, `bad base64 for ${f.path}`);
      }
    } else if (typeof f.content === "string") {
      buf = Buffer.from(f.content, "utf8");
    } else {
      return jsonError(400, `file ${f.path} needs content or base64.`);
    }
    ops.push({ path: f.path, op: f.op, content: buf });
  }

  let result;
  try {
    result = applyPatch({
      workspace_id: ws.id,
      agent_id: auth.agent.id,
      against_rev: body.against_rev,
      ops,
      commit_message: body.commit_message,
      thinking: body.thinking,
      task_id: body.task_id ?? null,
    });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Patch failed.");
  }
  if (!result.ok) {
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
  if (body.task_id) {
    try {
      addTaskArtifact(body.task_id, "snapshot", result.snapshot_id, auth.agent.id);
    } catch {
      // task may have been deleted between checks; non-fatal for the patch.
    }
  }
  return jsonOk({
    snapshot_id: result.snapshot_id,
    parent_snapshot_id: result.parent_snapshot_id,
    changed: result.changed,
  });
}
