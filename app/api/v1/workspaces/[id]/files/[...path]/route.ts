import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  canRead,
  getSnapshot,
  getWorkspace,
  readFileAt,
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
  {
    params,
  }: { params: Promise<{ id: string; path: string[] }> },
): Promise<Response> {
  const { id, path } = await params;
  const ws = getWorkspace(id);

  // Dual auth, same pattern as /api/v1/blobs/[id]: agents authenticate with
  // a Bearer key; a signed-in HUMAN may read/download too when they own a
  // member agent of the workspace's conversation (this is what the web file
  // viewer's Download button uses — browsers can't send agent keys).
  const auth = authenticateRequest(req);
  if (auth.ok) {
    const rl = consume(
      agentKey(auth.agent.id, "ws.file.read"),
      RATE_LIMITS.apiWorkspaceRead,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
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
  } else {
    const user = await getCurrentUser();
    if (!user) return jsonError(auth.status, auth.error);
    if (!ws) return jsonError(404, "Workspace not found.");
    const rl = consume(
      `ws.file.read:user:${user.id}`,
      RATE_LIMITS.apiWorkspaceRead,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    const member = db()
      .prepare(
        `SELECT 1 FROM conversation_members cm
         JOIN agents a ON a.id = cm.agent_id
         WHERE cm.conversation_id = ? AND a.owner_user_id = ? LIMIT 1`,
      )
      .get(ws.conversation_id, user.id);
    if (!member) return jsonError(404, "Workspace not found.");
  }

  const url = new URL(req.url);
  const rev = url.searchParams.get("rev") ?? ws.head_snapshot_id;
  if (!rev) return jsonError(404, "Workspace has no snapshot.");
  const snap = getSnapshot(rev);
  if (!snap || snap.workspace_id !== ws.id) {
    return jsonError(404, "Snapshot not found in this workspace.");
  }

  const joined = (path ?? []).join("/");
  let file;
  try {
    file = readFileAt(rev, joined);
  } catch (err) {
    return jsonError(
      400,
      err instanceof Error ? err.message : "Invalid path.",
    );
  }
  if (!file) return jsonError(404, "File not found at this rev.");

  // Browser-friendly download (the web viewer's Download button). Always
  // an attachment with a safe filename — never rendered inline, so a hostile
  // HTML/SVG file can't execute in our origin.
  if (url.searchParams.get("download") === "1") {
    const arr = new Uint8Array(file.content);
    const base = file.file.path.split("/").pop() || "file";
    const safeName = base.replace(/[^\w. -]/g, "_");
    return new Response(arr, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        "x-content-type-options": "nosniff",
        "x-workspace-rev": rev,
        "x-content-sha256": file.file.content_sha256,
        "content-length": String(arr.length),
      },
    });
  }

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/octet-stream") || url.searchParams.get("raw") === "1") {
    const arr = new Uint8Array(file.content);
    return new Response(arr, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-workspace-rev": rev,
        "x-content-sha256": file.file.content_sha256,
        "content-length": String(arr.length),
      },
    });
  }

  // default: JSON envelope (utf8 best-effort)
  return jsonOk({
    workspace_id: ws.id,
    rev,
    path: file.file.path,
    size: file.file.size_bytes,
    sha: file.file.content_sha256,
    content: file.content.toString("utf8"),
  });
}
