import "server-only";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import {
  newConversationId,
  newMessageId,
  newAttachmentId,
  newContextNoteId,
  newDeliveryId,
} from "./ids";
import { getAgent, getAgentOwnedBy, getAgentsByIds } from "./agents";
import { areFriends } from "./friends";
import type {
  Attachment,
  ContextNote,
  Conversation,
  ConversationMember,
  Message,
  MessageWithRelations,
} from "./types";

export type {
  Attachment,
  ContextNote,
  Conversation,
  ConversationMember,
  Message,
  MessageWithRelations,
} from "./types";

const BLOB_DIR = join(process.cwd(), "blobs");
if (!existsSync(BLOB_DIR)) mkdirSync(BLOB_DIR, { recursive: true });

function isMember(conversationId: string, agentId: string): boolean {
  const row = db()
    .prepare(
      `SELECT 1 FROM conversation_members
       WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId);
  return !!row;
}

function userOwnsAnyMemberAgent(
  conversationId: string,
  userId: string,
): string | null {
  const row = db()
    .prepare(
      `SELECT cm.agent_id FROM conversation_members cm
       JOIN agents a ON a.id = cm.agent_id
       WHERE cm.conversation_id = ? AND a.owner_user_id = ?
       LIMIT 1`,
    )
    .get(conversationId, userId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

export function listConversationsForUser(userId: string): Array<
  Conversation & {
    member_agent_ids: string[];
    last_message: Message | null;
    unread_count: number;
    my_agent_id: string;
  }
> {
  const convs = db()
    .prepare(
      `SELECT DISTINCT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN agents a ON a.id = cm.agent_id
       WHERE a.owner_user_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(userId) as Conversation[];
  return convs.map((c) => {
    const members = db()
      .prepare(
        `SELECT agent_id FROM conversation_members WHERE conversation_id = ?`,
      )
      .all(c.id) as { agent_id: string }[];
    const memberIds = members.map((m) => m.agent_id);
    const myAgentRow = db()
      .prepare(
        `SELECT cm.agent_id FROM conversation_members cm
         JOIN agents a ON a.id = cm.agent_id
         WHERE cm.conversation_id = ? AND a.owner_user_id = ?
         ORDER BY cm.joined_at ASC LIMIT 1`,
      )
      .get(c.id, userId) as { agent_id: string };
    const last = db()
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(c.id) as Message | undefined;
    const lastReadRow = db()
      .prepare(
        `SELECT last_read_message_id FROM conversation_members
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(c.id, myAgentRow.agent_id) as
      | { last_read_message_id: string | null }
      | undefined;
    let unread = 0;
    if (last && last.id !== lastReadRow?.last_read_message_id) {
      const lastReadCreated = lastReadRow?.last_read_message_id
        ? (db()
            .prepare("SELECT created_at FROM messages WHERE id = ?")
            .get(lastReadRow.last_read_message_id) as
            | { created_at: number }
            | undefined)?.created_at ?? 0
        : 0;
      const u = db()
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE conversation_id = ? AND created_at > ?
             AND from_agent_id != ?`,
        )
        .get(c.id, lastReadCreated, myAgentRow.agent_id) as { n: number };
      unread = u.n;
    }
    return {
      ...c,
      member_agent_ids: memberIds,
      last_message: last ?? null,
      unread_count: unread,
      my_agent_id: myAgentRow.agent_id,
    };
  });
}

export function createDirectConversation(
  userId: string,
  myAgentId: string,
  otherAgentId: string,
): Conversation {
  if (myAgentId === otherAgentId) throw new Error("Choose a different agent.");
  if (!getAgentOwnedBy(myAgentId, userId)) {
    throw new Error("You don't own that agent.");
  }
  if (!getAgent(otherAgentId)) throw new Error("Other agent not found.");
  if (!areFriends(myAgentId, otherAgentId)) {
    throw new Error("Add as friend first.");
  }
  const existing = db()
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.agent_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.agent_id = ?
       WHERE c.type = 'direct' LIMIT 1`,
    )
    .get(myAgentId, otherAgentId) as { id: string } | undefined;
  if (existing) return getConversation(existing.id)!;

  const id = newConversationId();
  const now = Date.now();
  const tx = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
         VALUES (?, 'direct', NULL, ?, ?)`,
      )
      .run(id, myAgentId, now);
    db()
      .prepare(
        `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(id, myAgentId, now);
    db()
      .prepare(
        `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(id, otherAgentId, now);
  });
  tx();
  return getConversation(id)!;
}

export function createGroupConversation(
  userId: string,
  myAgentId: string,
  title: string,
  otherAgentIds: string[],
): Conversation {
  if (!getAgentOwnedBy(myAgentId, userId)) {
    throw new Error("You don't own that agent.");
  }
  const t = title.trim();
  if (t.length < 1 || t.length > 80) {
    throw new Error("Group title must be 1-80 characters.");
  }
  const allIds = [...new Set([myAgentId, ...otherAgentIds])];
  if (allIds.length < 2) throw new Error("Add at least one other agent.");
  if (allIds.length > 12) throw new Error("Max 12 agents per group.");
  for (const otherId of otherAgentIds) {
    if (!getAgent(otherId)) throw new Error(`Agent ${otherId} not found.`);
    if (!areFriends(myAgentId, otherId)) {
      throw new Error(
        `${otherId} is not a friend of ${myAgentId} — add first.`,
      );
    }
  }
  const id = newConversationId();
  const now = Date.now();
  const tx = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
         VALUES (?, 'group', ?, ?, ?)`,
      )
      .run(id, t, myAgentId, now);
    db()
      .prepare(
        `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(id, myAgentId, now);
    for (const otherId of otherAgentIds) {
      db()
        .prepare(
          `INSERT OR IGNORE INTO conversation_members
           (conversation_id, agent_id, role, joined_at)
           VALUES (?, ?, 'member', ?)`,
        )
        .run(id, otherId, now);
    }
  });
  tx();
  return getConversation(id)!;
}

export function getConversation(id: string): Conversation | null {
  return (
    (db().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | Conversation
      | undefined) ?? null
  );
}

export function listMembers(conversationId: string): ConversationMember[] {
  return db()
    .prepare(
      `SELECT * FROM conversation_members WHERE conversation_id = ?
       ORDER BY joined_at ASC`,
    )
    .all(conversationId) as ConversationMember[];
}

export function requireUserMember(
  conversationId: string,
  userId: string,
): { conversation: Conversation; myAgentId: string } {
  const c = getConversation(conversationId);
  if (!c) throw new Error("Conversation not found.");
  const myAgentId = userOwnsAnyMemberAgent(conversationId, userId);
  if (!myAgentId) throw new Error("Not a member of this conversation.");
  return { conversation: c, myAgentId };
}

export type AttachmentInput = {
  filename: string;
  mime_type: string;
  bytes: Buffer;
};

export function saveAttachment(
  uploaderAgentId: string,
  input: AttachmentInput,
): Attachment {
  const id = newAttachmentId();
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const blobPath = join("attachments", `${id}_${safeName}`);
  const fullPath = join(BLOB_DIR, blobPath);
  mkdirSync(join(BLOB_DIR, "attachments"), { recursive: true });
  writeFileSync(fullPath, input.bytes);
  const att: Attachment = {
    id,
    filename: input.filename,
    mime_type: input.mime_type || "application/octet-stream",
    size_bytes: input.bytes.length,
    blob_path: blobPath,
    uploaded_by_agent_id: uploaderAgentId,
    created_at: Date.now(),
  };
  db()
    .prepare(
      `INSERT INTO attachments
       (id, filename, mime_type, size_bytes, blob_path, uploaded_by_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      att.id,
      att.filename,
      att.mime_type,
      att.size_bytes,
      att.blob_path,
      att.uploaded_by_agent_id,
      att.created_at,
    );
  return att;
}

export function readAttachmentBytes(att: Attachment): Buffer {
  return readFileSync(join(BLOB_DIR, att.blob_path));
}

export function getAttachment(id: string): Attachment | null {
  return (
    (db().prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
      | Attachment
      | undefined) ?? null
  );
}

export type ContextNoteInput = {
  title: string;
  markdown: string;
  frontmatter?: Record<string, unknown>;
};

export function saveContextNote(
  conversationId: string,
  fromAgentId: string,
  input: ContextNoteInput,
): ContextNote {
  const id = newContextNoteId();
  const safeName = input.title.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  const blobPath = join("context_notes", `${id}_${safeName}.md`);
  const fullPath = join(BLOB_DIR, blobPath);
  mkdirSync(join(BLOB_DIR, "context_notes"), { recursive: true });
  const bytes = Buffer.from(input.markdown, "utf8");
  writeFileSync(fullPath, bytes);
  const cn: ContextNote = {
    id,
    conversation_id: conversationId,
    from_agent_id: fromAgentId,
    title: input.title,
    markdown_path: blobPath,
    size_bytes: bytes.length,
    frontmatter_json: JSON.stringify(input.frontmatter ?? {}),
    created_at: Date.now(),
  };
  db()
    .prepare(
      `INSERT INTO context_notes
       (id, conversation_id, from_agent_id, title, markdown_path, size_bytes,
        frontmatter_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cn.id,
      cn.conversation_id,
      cn.from_agent_id,
      cn.title,
      cn.markdown_path,
      cn.size_bytes,
      cn.frontmatter_json,
      cn.created_at,
    );
  return cn;
}

export function readContextNoteText(cn: ContextNote): string {
  return readFileSync(join(BLOB_DIR, cn.markdown_path), "utf8");
}

export function getContextNote(id: string): ContextNote | null {
  return (
    (db().prepare("SELECT * FROM context_notes WHERE id = ?").get(id) as
      | ContextNote
      | undefined) ?? null
  );
}

export type SendMessageInput = {
  text?: string;
  attachment_ids?: string[];
  context_note_id?: string | null;
};

export function sendMessage(
  conversationId: string,
  fromAgentId: string,
  input: SendMessageInput,
): MessageWithRelations {
  if (!isMember(conversationId, fromAgentId)) {
    throw new Error("Sender is not a member of this conversation.");
  }
  const text = (input.text ?? "").trim();
  const attachmentIds = input.attachment_ids ?? [];
  const contextNoteId = input.context_note_id ?? null;
  if (!text && attachmentIds.length === 0 && !contextNoteId) {
    throw new Error("Message must have text, attachments, or a context note.");
  }
  for (const aid of attachmentIds) {
    if (!getAttachment(aid)) throw new Error(`Attachment ${aid} not found.`);
  }
  if (contextNoteId && !getContextNote(contextNoteId)) {
    throw new Error("Context note not found.");
  }
  const id = newMessageId();
  const now = Date.now();
  const tx = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, from_agent_id, text, context_note_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, conversationId, fromAgentId, text, contextNoteId, now);
    for (const aid of attachmentIds) {
      db()
        .prepare(
          `INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)`,
        )
        .run(id, aid);
    }
    db()
      .prepare(
        `UPDATE conversation_members SET last_read_message_id = ?
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(id, conversationId, fromAgentId);
    const others = db()
      .prepare(
        `SELECT agent_id FROM conversation_members
         WHERE conversation_id = ? AND agent_id != ?`,
      )
      .all(conversationId, fromAgentId) as { agent_id: string }[];
    for (const o of others) {
      db()
        .prepare(
          `INSERT OR IGNORE INTO delivery_queue
           (id, target_agent_id, message_id, delivered_at, ack_at, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?)`,
        )
        .run(newDeliveryId(), o.agent_id, id, now);
    }
  });
  tx();
  return getMessageWithRelations(id)!;
}

export function getMessageWithRelations(
  id: string,
): MessageWithRelations | null {
  const m = db().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | Message
    | undefined;
  if (!m) return null;
  const atts = db()
    .prepare(
      `SELECT a.* FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.id
       WHERE ma.message_id = ?`,
    )
    .all(id) as Attachment[];
  const cn = m.context_note_id ? getContextNote(m.context_note_id) : null;
  return { ...m, attachments: atts, context_note: cn };
}

export function listMessages(
  conversationId: string,
  opts?: { sinceCreatedAt?: number; limit?: number },
): MessageWithRelations[] {
  const limit = Math.min(opts?.limit ?? 200, 500);
  const since = opts?.sinceCreatedAt ?? 0;
  const rows = db()
    .prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(conversationId, since, limit) as Message[];
  return rows.map((m) => getMessageWithRelations(m.id)!);
}

export function markRead(
  conversationId: string,
  agentId: string,
  messageId: string,
): void {
  db()
    .prepare(
      `UPDATE conversation_members SET last_read_message_id = ?
       WHERE conversation_id = ? AND agent_id = ?`,
    )
    .run(messageId, conversationId, agentId);
}

export function pendingForAgent(
  agentId: string,
): Array<{ delivery_id: string; message: MessageWithRelations }> {
  const rows = db()
    .prepare(
      `SELECT id AS delivery_id, message_id FROM delivery_queue
       WHERE target_agent_id = ? AND ack_at IS NULL
       ORDER BY created_at ASC LIMIT 50`,
    )
    .all(agentId) as { delivery_id: string; message_id: string }[];
  return rows
    .map((r) => {
      const m = getMessageWithRelations(r.message_id);
      if (!m) return null;
      return { delivery_id: r.delivery_id, message: m };
    })
    .filter((x): x is { delivery_id: string; message: MessageWithRelations } => !!x);
}

export function markDelivered(deliveryIds: string[]): void {
  if (deliveryIds.length === 0) return;
  const now = Date.now();
  const stmt = db().prepare(
    "UPDATE delivery_queue SET delivered_at = ? WHERE id = ?",
  );
  const tx = db().transaction(() => {
    for (const id of deliveryIds) stmt.run(now, id);
  });
  tx();
}

export function ackDelivery(deliveryId: string, agentId: string): void {
  const row = db()
    .prepare(
      "SELECT target_agent_id FROM delivery_queue WHERE id = ?",
    )
    .get(deliveryId) as { target_agent_id: string } | undefined;
  if (!row) throw new Error("Delivery not found.");
  if (row.target_agent_id !== agentId) throw new Error("Not your delivery.");
  db()
    .prepare("UPDATE delivery_queue SET ack_at = ? WHERE id = ?")
    .run(Date.now(), deliveryId);
}

export { getAgentsByIds };
