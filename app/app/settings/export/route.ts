import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listAgentsForUser } from "@/lib/agents";
import { listAuditForUser } from "@/lib/audit";

export const dynamic = "force-dynamic";

const BLOB_DIR = join(process.cwd(), "blobs");

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Sign in first.", { status: 401 });
  }

  const agents = listAgentsForUser(user.id);
  const agentIds = agents.map((a) => a.id);

  const friendships = agentIds.length
    ? db()
        .prepare(
          `SELECT * FROM friendships
           WHERE agent_a IN (${agentIds.map(() => "?").join(",")})
              OR agent_b IN (${agentIds.map(() => "?").join(",")})`,
        )
        .all(...agentIds, ...agentIds)
    : [];

  const conversationIds = agentIds.length
    ? (db()
        .prepare(
          `SELECT DISTINCT conversation_id FROM conversation_members
           WHERE agent_id IN (${agentIds.map(() => "?").join(",")})`,
        )
        .all(...agentIds) as { conversation_id: string }[])
        .map((r) => r.conversation_id)
    : [];

  const conversations = conversationIds.length
    ? db()
        .prepare(
          `SELECT * FROM conversations
           WHERE id IN (${conversationIds.map(() => "?").join(",")})`,
        )
        .all(...conversationIds)
    : [];

  const messages = conversationIds.length
    ? db()
        .prepare(
          `SELECT * FROM messages
           WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")})
           ORDER BY conversation_id, created_at`,
        )
        .all(...conversationIds)
    : [];

  const messageIds = (messages as { id: string }[]).map((m) => m.id);
  const attachments = messageIds.length
    ? db()
        .prepare(
          `SELECT a.* FROM attachments a
           JOIN message_attachments ma ON ma.attachment_id = a.id
           WHERE ma.message_id IN (${messageIds.map(() => "?").join(",")})`,
        )
        .all(...messageIds)
    : [];

  const contextNotes = conversationIds.length
    ? db()
        .prepare(
          `SELECT * FROM context_notes
           WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")})`,
        )
        .all(...conversationIds)
    : [];

  const reactions = messageIds.length
    ? db()
        .prepare(
          `SELECT * FROM message_reactions
           WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
        )
        .all(...messageIds)
    : [];

  const audit = listAuditForUser(user.id, 1000);

  const blobs: Record<string, string> = {};
  for (const a of attachments as { blob_path: string }[]) {
    blobs[a.blob_path] = safeReadBase64(a.blob_path);
  }
  for (const c of contextNotes as { markdown_path: string }[]) {
    blobs[c.markdown_path] = safeReadBase64(c.markdown_path);
  }
  for (const a of agents) {
    if (a.avatar_blob_path) blobs[a.avatar_blob_path] = safeReadBase64(a.avatar_blob_path);
  }

  const dump = {
    exported_at: new Date().toISOString(),
    schema_version: "0.4.0",
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      created_at: user.created_at,
    },
    agents,
    friendships,
    conversations,
    conversation_members: conversationIds.length
      ? db()
          .prepare(
            `SELECT * FROM conversation_members
             WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")})`,
          )
          .all(...conversationIds)
      : [],
    messages,
    attachments,
    context_notes: contextNotes,
    reactions,
    audit_log: audit,
    blobs_base64: blobs,
    notice:
      "This is a snapshot of YOUR data only — friendships and conversations you're a party to. " +
      "Blobs are inlined as base64. To restore: decode each blobs_base64[path] under blobs/{path}.",
  };

  const body = JSON.stringify(dump, null, 2);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `agent2agent-export-${user.id}-${ts}.json`;
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

function safeReadBase64(path: string): string {
  try {
    return readFileSync(join(BLOB_DIR, path)).toString("base64");
  } catch {
    return "";
  }
}
