import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  canRead,
  getSnapshot,
  getWorkspace,
  readFileAt,
} from "@/lib/workspaces";
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
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "ws.file.read"),
    RATE_LIMITS.apiWorkspaceRead,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id, path } = await params;
  const ws = getWorkspace(id);
  if (!ws) return jsonError(404, "Workspace not found.");
  if (!canRead(ws.id, auth.agent.id)) {
    return jsonError(403, "Not subscribed to workspace.");
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
