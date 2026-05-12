import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { listToolsForAgent } from "@/lib/tools";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  return jsonOk({ tools: listToolsForAgent(auth.agent) });
}
