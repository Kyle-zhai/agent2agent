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
import { validateFileBytes } from "./file-validation";
import { logAudit } from "./audit";
import type {
  Attachment,
  ContextNote,
  Conversation,
  ConversationMember,
  ConversationState,
  Message,
  MessageKind,
  MessageReaction,
  MessageWithRelations,
  ReactionAggregate,
} from "./types";

export type {
  Attachment,
  ContextNote,
  Conversation,
  ConversationMember,
  ConversationState,
  Message,
  MessageKind,
  MessageReaction,
  MessageWithRelations,
  ReactionAggregate,
} from "./types";

const BLOB_DIR = join(process.cwd(), "blobs");
if (!existsSync(BLOB_DIR)) mkdirSync(BLOB_DIR, { recursive: true });

export const MAX_GROUP_SIZE = 12;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 8000;
export const MAX_THINKING_LENGTH = 16000;

type AfterMessageHook = (
  conversationId: string,
  messageId: string,
  fromAgentId: string,
) => void;
const afterMessageHooks: AfterMessageHook[] = [];
export function onMessageSent(hook: AfterMessageHook): void {
  afterMessageHooks.push(hook);
}

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
  // When the user owns multiple member agents, prefer EXTERNAL ones — they
  // represent the human typing. Managed agents reply autonomously, so the
  // human shouldn't be put behind the keyboard of one by default.
  const row = db()
    .prepare(
      `SELECT cm.agent_id FROM conversation_members cm
       JOIN agents a ON a.id = cm.agent_id
       WHERE cm.conversation_id = ? AND a.owner_user_id = ?
       ORDER BY
         CASE WHEN a.agent_kind = 'managed' THEN 1 ELSE 0 END,
         cm.joined_at ASC
       LIMIT 1`,
    )
    .get(conversationId, userId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

// listConversationsForUser was retired in v0.4.3 — it used joined_at-only
// ordering to pick "my agent" while listConversationsWithState prefers
// external-first, leading to inconsistent unread cursors. Use
// listConversationsWithState exclusively.

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
  if (input.bytes.length === 0) {
    throw new Error("Attachment is empty.");
  }
  const validated = validateFileBytes(
    input.bytes,
    MAX_ATTACHMENT_BYTES,
    input.mime_type,
  );
  if (validated.oversized) {
    throw new Error("Attachment exceeds 25 MB.");
  }
  // If a binary type was claimed but bytes don't match a known magic + aren't text, force generic.
  let mime = input.mime_type || "application/octet-stream";
  if (validated.detectedMime && validated.detectedMime !== mime) {
    // Trust the detected type over a possibly-spoofed declared type.
    mime = validated.detectedMime;
  } else if (!validated.detectedMime && !validated.textual) {
    mime = "application/octet-stream";
  }

  const id = newAttachmentId();
  // Store with ID-only filename to neutralize any path/script tricks in user filename.
  const blobPath = join("attachments", `${id}.bin`);
  const fullPath = join(BLOB_DIR, blobPath);
  mkdirSync(join(BLOB_DIR, "attachments"), { recursive: true });
  writeFileSync(fullPath, input.bytes);
  // Sanitize the displayed filename.
  const safeName = input.filename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]/g, "_")
    .slice(0, 200);
  const att: Attachment = {
    id,
    filename: safeName || "attachment",
    mime_type: mime,
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

export const EDIT_DELETE_WINDOW_MS = 5 * 60 * 1000;

export type SendMessageInput = {
  text?: string;
  thinking?: string;
  kind?: MessageKind;
  attachment_ids?: string[];
  context_note_id?: string | null;
  reply_to_message_id?: string | null;
};

export function sendMessage(
  conversationId: string,
  fromAgentId: string,
  input: SendMessageInput,
): MessageWithRelations {
  if (!isMember(conversationId, fromAgentId)) {
    throw new Error("Sender is not a member of this conversation.");
  }
  const text = (input.text ?? "").trim().slice(0, MAX_TEXT_LENGTH);
  const thinking = (input.thinking ?? "").trim().slice(0, MAX_THINKING_LENGTH);
  const kind: MessageKind = input.kind ?? "normal";
  if (!["normal", "agent_to_agent", "system"].includes(kind)) {
    throw new Error("Invalid message kind.");
  }
  const attachmentIds = input.attachment_ids ?? [];
  if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(
      `Max ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
    );
  }
  const contextNoteId = input.context_note_id ?? null;
  const replyToId = input.reply_to_message_id ?? null;
  if (!text && !thinking && attachmentIds.length === 0 && !contextNoteId) {
    throw new Error("Message must have text, thinking, attachments, or a context note.");
  }
  for (const aid of attachmentIds) {
    if (!getAttachment(aid)) throw new Error(`Attachment ${aid} not found.`);
  }
  if (contextNoteId && !getContextNote(contextNoteId)) {
    throw new Error("Context note not found.");
  }
  if (replyToId) {
    const parent = db()
      .prepare("SELECT id, conversation_id FROM messages WHERE id = ?")
      .get(replyToId) as { id: string; conversation_id: string } | undefined;
    if (!parent || parent.conversation_id !== conversationId) {
      throw new Error("reply_to_message_id must be a message in the same conversation.");
    }
  }
  const id = newMessageId();
  const now = Date.now();
  const tx = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, from_agent_id, text, thinking, kind,
          context_note_id, reply_to_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, conversationId, fromAgentId, text, thinking, kind,
        contextNoteId, replyToId, now,
      );
    db()
      .prepare(
        `INSERT INTO messages_fts (message_id, conversation_id, text, thinking)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, conversationId, text, thinking);
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
    db()
      .prepare("UPDATE agents SET last_message_at = ? WHERE id = ?")
      .run(now, fromAgentId);
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
    db()
      .prepare(
        `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
         VALUES (?, 'message', ?, ?)`,
      )
      .run(conversationId, id, now);
  });
  tx();
  for (const hook of afterMessageHooks) {
    try {
      hook(conversationId, id, fromAgentId);
    } catch (err) {
      // best-effort: notification + reply-job hooks fail loud-ish to the
      // server log but never roll back the message insert. If they vanish
      // silently the user's message would still post but nothing downstream
      // would react.
      console.error("afterMessageHook failed", {
        conversationId,
        messageId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return getMessageWithRelations(id)!;
}

export function listConversationEventsAfter(
  conversationId: string,
  afterId: number,
  limit = 50,
): Array<{
  id: number;
  kind: string;
  message_id: string | null;
  ref_id: string | null;
  created_at: number;
}> {
  return db()
    .prepare(
      `SELECT id, kind, message_id, ref_id, created_at FROM conversation_events
       WHERE conversation_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(conversationId, afterId, limit) as Array<{
    id: number;
    kind: string;
    message_id: string | null;
    ref_id: string | null;
    created_at: number;
  }>;
}

export function recordConversationEvent(
  conversationId: string,
  kind: string,
  refId: string | null,
): void {
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, message_id, ref_id, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(conversationId, kind, refId, Date.now());
}

export function getMaxConversationEventId(conversationId: string): number {
  const row = db()
    .prepare(
      `SELECT MAX(id) AS max_id FROM conversation_events WHERE conversation_id = ?`,
    )
    .get(conversationId) as { max_id: number | null };
  return row.max_id ?? 0;
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

export function editMessage(
  messageId: string,
  fromAgentId: string,
  newText: string,
): Message {
  const m = db()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(messageId) as Message | undefined;
  if (!m) throw new Error("Message not found.");
  if (m.from_agent_id !== fromAgentId) {
    throw new Error("Can only edit your own messages.");
  }
  if (m.deleted_at) throw new Error("Cannot edit a deleted message.");
  if (Date.now() - m.created_at > EDIT_DELETE_WINDOW_MS) {
    const windowMinutes = Math.round(EDIT_DELETE_WINDOW_MS / 60000);
    throw new Error(`Edit window has passed (${windowMinutes} minutes).`);
  }
  const text = newText.trim().slice(0, MAX_TEXT_LENGTH);
  const now = Date.now();
  db()
    .prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?")
    .run(text, now, messageId);
  // Update FTS row.
  db()
    .prepare(
      `DELETE FROM messages_fts WHERE message_id = ?`,
    )
    .run(messageId);
  db()
    .prepare(
      `INSERT INTO messages_fts (message_id, conversation_id, text, thinking)
       VALUES (?, ?, ?, ?)`,
    )
    .run(messageId, m.conversation_id, text, m.thinking);
  // Conversation event so SSE clients pick it up.
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
       VALUES (?, 'edit', ?, ?)`,
    )
    .run(m.conversation_id, messageId, now);
  logAudit("message.edit", {
    agentId: fromAgentId,
    detail: { message_id: messageId, conversation_id: m.conversation_id },
  });
  return { ...m, text, edited_at: now };
}

export function forwardMessage(
  sourceMessageId: string,
  targetConversationId: string,
  sourceByAgentId: string,
  targetByAgentId: string,
): MessageWithRelations {
  const src = db()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(sourceMessageId) as Message | undefined;
  if (!src) throw new Error("Source message not found.");
  if (src.deleted_at) throw new Error("Cannot forward a deleted message.");
  if (!isMember(src.conversation_id, sourceByAgentId)) {
    throw new Error("Not a member of source conversation.");
  }
  if (!isMember(targetConversationId, targetByAgentId)) {
    throw new Error("Not a member of target conversation.");
  }
  if (src.conversation_id === targetConversationId) {
    throw new Error("Pick a different conversation to forward to.");
  }
  // Copy attachments by reference (same blob ids).
  const atts = db()
    .prepare(
      "SELECT attachment_id FROM message_attachments WHERE message_id = ?",
    )
    .all(sourceMessageId) as { attachment_id: string }[];
  const fromAgent = db()
    .prepare("SELECT display_name FROM agents WHERE id = ?")
    .get(src.from_agent_id) as { display_name: string } | undefined;
  // Render time in ISO so the recipient's UI can re-format in their tz.
  const when = new Date(src.created_at).toISOString();
  const text = `↪ Forwarded from ${fromAgent?.display_name ?? src.from_agent_id} (${when}):\n${src.text}`;
  return sendMessage(targetConversationId, targetByAgentId, {
    text,
    attachment_ids: atts.map((a) => a.attachment_id),
    kind: "normal",
  });
}

export function deleteMessage(
  messageId: string,
  fromAgentId: string,
): Message {
  const m = db()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(messageId) as Message | undefined;
  if (!m) throw new Error("Message not found.");
  if (m.from_agent_id !== fromAgentId) {
    throw new Error("Can only delete your own messages.");
  }
  if (m.deleted_at) return m;
  const windowMinutes = Math.round(EDIT_DELETE_WINDOW_MS / 60000);
  if (Date.now() - m.created_at > EDIT_DELETE_WINDOW_MS) {
    throw new Error(`Delete window has passed (${windowMinutes} minutes).`);
  }
  const now = Date.now();
  db()
    .prepare(
      `UPDATE messages SET deleted_at = ?, text = '', thinking = '' WHERE id = ?`,
    )
    .run(now, messageId);
  db().prepare(`DELETE FROM messages_fts WHERE message_id = ?`).run(messageId);
  // Reactions on tombstoned messages would imply some user reacted to nothing.
  // Drop them so the bubble stops carrying counts after delete.
  db().prepare(`DELETE FROM message_reactions WHERE message_id = ?`).run(messageId);
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
       VALUES (?, 'delete', ?, ?)`,
    )
    .run(m.conversation_id, messageId, now);
  logAudit("message.delete", {
    agentId: fromAgentId,
    detail: { message_id: messageId, conversation_id: m.conversation_id },
  });
  return { ...m, text: "", thinking: "", deleted_at: now };
}

export function listReactions(messageIds: string[]): Map<string, ReactionAggregate[]> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT message_id, agent_id, emoji, created_at FROM message_reactions
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all(...messageIds) as MessageReaction[];
  const out = new Map<string, ReactionAggregate[]>();
  for (const r of rows) {
    let agg = out.get(r.message_id);
    if (!agg) {
      agg = [];
      out.set(r.message_id, agg);
    }
    let row = agg.find((x) => x.emoji === r.emoji);
    if (!row) {
      row = { emoji: r.emoji, count: 0, agent_ids: [] };
      agg.push(row);
    }
    row.count++;
    row.agent_ids.push(r.agent_id);
  }
  return out;
}

export const REACTION_EMOJIS = [
  "👍", "👎", "❤️", "😂", "😮", "😢", "🎉", "🚀", "✅", "❌", "🤔", "🔥",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
const ALLOWED_REACTIONS = new Set<string>(REACTION_EMOJIS);

export function toggleReaction(
  messageId: string,
  agentId: string,
  emoji: string,
): { added: boolean } {
  if (!ALLOWED_REACTIONS.has(emoji)) {
    throw new Error("Reaction emoji not allowed.");
  }
  const m = db()
    .prepare(
      "SELECT conversation_id, deleted_at FROM messages WHERE id = ?",
    )
    .get(messageId) as
    | { conversation_id: string; deleted_at: number | null }
    | undefined;
  if (!m) throw new Error("Message not found.");
  if (m.deleted_at) throw new Error("Cannot react to a deleted message.");
  if (!isMember(m.conversation_id, agentId)) {
    throw new Error("Not a member of that conversation.");
  }
  const existing = db()
    .prepare(
      `SELECT 1 FROM message_reactions
       WHERE message_id = ? AND agent_id = ? AND emoji = ?`,
    )
    .get(messageId, agentId, emoji);
  const now = Date.now();
  if (existing) {
    db()
      .prepare(
        `DELETE FROM message_reactions
         WHERE message_id = ? AND agent_id = ? AND emoji = ?`,
      )
      .run(messageId, agentId, emoji);
  } else {
    db()
      .prepare(
        `INSERT INTO message_reactions (message_id, agent_id, emoji, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(messageId, agentId, emoji, now);
  }
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
       VALUES (?, 'reaction', ?, ?)`,
    )
    .run(m.conversation_id, messageId, now);
  logAudit("message.react", {
    agentId,
    detail: {
      message_id: messageId,
      conversation_id: m.conversation_id,
      emoji,
      added: !existing,
    },
  });
  return { added: !existing };
}

export function getConversationState(
  conversationId: string,
  agentId: string,
): ConversationState {
  const row = db()
    .prepare(
      `SELECT conversation_id, agent_id, pinned_at, muted_at, archived_at
       FROM conversation_state WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId) as ConversationState | undefined;
  return (
    row ?? {
      conversation_id: conversationId,
      agent_id: agentId,
      pinned_at: null,
      muted_at: null,
      archived_at: null,
    }
  );
}

export type ConversationStateField = "pinned_at" | "muted_at" | "archived_at";

export function toggleConversationState(
  conversationId: string,
  agentId: string,
  field: ConversationStateField,
): { value: number | null } {
  if (!isMember(conversationId, agentId)) {
    throw new Error("Not a member of that conversation.");
  }
  const cur = getConversationState(conversationId, agentId);
  const now = Date.now();
  const next = cur[field] ? null : now;
  db()
    .prepare(
      `INSERT INTO conversation_state (conversation_id, agent_id, ${field})
       VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, agent_id) DO UPDATE SET ${field} = excluded.${field}`,
    )
    .run(conversationId, agentId, next);
  return { value: next };
}

export function setGroupTitle(
  conversationId: string,
  byAgentId: string,
  title: string,
): void {
  const conv = getConversation(conversationId);
  if (!conv) throw new Error("Conversation not found.");
  if (conv.type !== "group") throw new Error("Only group titles can be edited.");
  if (conv.created_by_agent_id !== byAgentId) {
    throw new Error("Only the creator can rename the group.");
  }
  const t = title.trim().slice(0, 80);
  if (t.length < 1) throw new Error("Title cannot be empty.");
  db().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(t, conversationId);
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, created_at)
       VALUES (?, 'title', ?)`,
    )
    .run(conversationId, Date.now());
  logAudit("conversation.title_change", {
    agentId: byAgentId,
    detail: { conversation_id: conversationId, title: t },
  });
}

export function addGroupMember(
  conversationId: string,
  byAgentId: string,
  newMemberId: string,
): void {
  const conv = getConversation(conversationId);
  if (!conv) throw new Error("Conversation not found.");
  if (conv.type !== "group") throw new Error("Only groups can add members.");
  if (conv.created_by_agent_id !== byAgentId) {
    throw new Error("Only the group owner can add members.");
  }
  if (!getAgent(newMemberId)) throw new Error("Agent not found.");
  const existing = db()
    .prepare(
      "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
    )
    .get(conversationId, newMemberId);
  if (existing) throw new Error("Already a member.");
  const memberCount = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?")
      .get(conversationId) as { n: number }
  ).n;
  if (memberCount >= MAX_GROUP_SIZE) {
    throw new Error(`Max ${MAX_GROUP_SIZE} members per group.`);
  }
  // Must be a friend of the inviting agent.
  if (!areFriends(byAgentId, newMemberId)) {
    throw new Error("Add as friend first.");
  }
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    )
    .run(conversationId, newMemberId, now);
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, created_at)
       VALUES (?, 'member_added', ?)`,
    )
    .run(conversationId, now);
  logAudit("conversation.member_add", {
    agentId: byAgentId,
    detail: { conversation_id: conversationId, added: newMemberId },
  });
}

export function removeGroupMember(
  conversationId: string,
  byAgentId: string,
  removeAgentId: string,
): void {
  const conv = getConversation(conversationId);
  if (!conv) throw new Error("Conversation not found.");
  if (conv.type !== "group") throw new Error("Only groups have members.");
  if (
    conv.created_by_agent_id !== byAgentId &&
    byAgentId !== removeAgentId
  ) {
    throw new Error("Only the owner can remove other members.");
  }
  if (removeAgentId === conv.created_by_agent_id && byAgentId === conv.created_by_agent_id) {
    throw new Error("Owner cannot remove themselves — delete the group instead.");
  }
  db()
    .prepare(
      `DELETE FROM conversation_members WHERE conversation_id = ? AND agent_id = ?`,
    )
    .run(conversationId, removeAgentId);
  db()
    .prepare(
      `INSERT INTO conversation_events (conversation_id, kind, created_at)
       VALUES (?, 'member_removed', ?)`,
    )
    .run(conversationId, Date.now());
  logAudit("conversation.member_remove", {
    agentId: byAgentId,
    detail: {
      conversation_id: conversationId,
      removed: removeAgentId,
      kind: byAgentId === removeAgentId ? "leave" : "kick",
    },
  });
}

export function listConversationsWithState(userId: string): Array<{
  conversation: Conversation;
  member_agent_ids: string[];
  my_agent_id: string;
  state: ConversationState;
  last_message: Message | null;
  unread_count: number;
}> {
  const convs = db()
    .prepare(
      `SELECT DISTINCT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN agents a ON a.id = cm.agent_id
       WHERE a.owner_user_id = ?`,
    )
    .all(userId) as Conversation[];
  return convs.map((c) => {
    const memberRows = db()
      .prepare("SELECT agent_id FROM conversation_members WHERE conversation_id = ?")
      .all(c.id) as { agent_id: string }[];
    const myAgentRow = db()
      .prepare(
        `SELECT cm.agent_id FROM conversation_members cm
         JOIN agents a ON a.id = cm.agent_id
         WHERE cm.conversation_id = ? AND a.owner_user_id = ?
         ORDER BY
           CASE WHEN a.agent_kind = 'managed' THEN 1 ELSE 0 END,
           cm.joined_at ASC LIMIT 1`,
      )
      .get(c.id, userId) as { agent_id: string };
    const state = getConversationState(c.id, myAgentRow.agent_id);
    const last = db()
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL
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
      conversation: c,
      member_agent_ids: memberRows.map((r) => r.agent_id),
      my_agent_id: myAgentRow.agent_id,
      state,
      last_message: last ?? null,
      unread_count: unread,
    };
  });
}

export function getPersonaOverride(
  conversationId: string,
  agentId: string,
): string | null {
  const row = db()
    .prepare(
      `SELECT persona FROM conversation_personas
       WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId) as { persona: string } | undefined;
  return row?.persona ?? null;
}

export function setPersonaOverride(
  conversationId: string,
  agentId: string,
  persona: string,
): void {
  if (!isMember(conversationId, agentId)) {
    throw new Error("Agent is not a member of this conversation.");
  }
  const trimmed = persona.trim().slice(0, 4000);
  const now = Date.now();
  if (!trimmed) {
    db()
      .prepare(
        `DELETE FROM conversation_personas
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(conversationId, agentId);
    logAudit("conversation.persona_override", {
      agentId,
      detail: { conversation_id: conversationId, action: "cleared" },
    });
    return;
  }
  db()
    .prepare(
      `INSERT INTO conversation_personas (conversation_id, agent_id, persona, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id, agent_id) DO UPDATE SET
         persona = excluded.persona, updated_at = excluded.updated_at`,
    )
    .run(conversationId, agentId, trimmed, now);
  logAudit("conversation.persona_override", {
    agentId,
    detail: {
      conversation_id: conversationId,
      action: "set",
      length: trimmed.length,
    },
  });
}

export function listRunningReplyJobsForConversation(
  conversationId: string,
): Array<{ agent_id: string; started_at: number | null }> {
  return db()
    .prepare(
      `SELECT agent_id, started_at FROM reply_jobs
       WHERE conversation_id = ? AND status IN ('pending','running')`,
    )
    .all(conversationId) as Array<{ agent_id: string; started_at: number | null }>;
}

export function listRecentFailedReplyJobs(
  conversationId: string,
  withinMs = 5 * 60_000,
): Array<{
  job_id: string;
  agent_id: string;
  trigger_message_id: string | null;
  last_error: string | null;
  finished_at: number | null;
}> {
  const cutoff = Date.now() - withinMs;
  return db()
    .prepare(
      `SELECT id AS job_id, agent_id, trigger_message_id, last_error, finished_at
       FROM reply_jobs
       WHERE conversation_id = ? AND status = 'failed'
         AND (finished_at IS NULL OR finished_at > ?)
       ORDER BY finished_at DESC LIMIT 20`,
    )
    .all(conversationId, cutoff) as Array<{
    job_id: string;
    agent_id: string;
    trigger_message_id: string | null;
    last_error: string | null;
    finished_at: number | null;
  }>;
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
