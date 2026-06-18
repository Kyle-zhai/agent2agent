import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  canRead,
  fileDiffSummary,
  getSnapshot,
  getWorkspace,
  listFiles,
  listSnapshotsForWorkspace,
  listSubscribers,
} from "@/lib/workspaces";
import { agentMayUseResource } from "@/lib/grants";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "ws.read"),
    RATE_LIMITS.apiWorkspaceRead,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return jsonError(404, "Workspace not found.");
  if (
    !canRead(ws.id, auth.agent.id) &&
    !agentMayUseResource({
      using_agent_id: auth.agent.id,
      resource_type: "workspace",
      resource_id: ws.id,
      required_scope: "read",
    })
  ) {
    return jsonError(403, "Not subscribed and no read grant for this workspace.");
  }

  const head = ws.head_snapshot_id ? getSnapshot(ws.head_snapshot_id) : null;
  const headFiles = ws.head_snapshot_id ? listFiles(ws.head_snapshot_id) : [];
  const recentSnapshots = listSnapshotsForWorkspace(ws.id, 20).map((s) => ({
    id: s.id,
    parent: s.parent_snapshot_id,
    by: s.created_by_agent_id,
    commit_message: s.commit_message,
    task_id: s.task_id,
    diff: fileDiffSummary(s.parent_snapshot_id, s.id),
    created_at: s.created_at,
  }));
  return jsonOk({
    workspace: ws,
    head,
    files: headFiles.map((f) => ({
      path: f.path,
      sha: f.content_sha256,
      size: f.size_bytes,
    })),
    subscribers: listSubscribers(ws.id),
    snapshots: recentSnapshots,
  });
}
