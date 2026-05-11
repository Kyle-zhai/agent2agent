import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import {
  addGroupMember,
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversation,
  getConversationState,
  listConversationsWithState,
  listMembers,
  listMessages,
  listReactions,
  listRunningReplyJobsForConversation,
  markRead,
  removeGroupMember,
  requireUserMember,
  saveAttachment,
  saveContextNote,
  sendMessage,
  setGroupTitle,
  toggleConversationState,
  toggleReaction,
} from "@/lib/conversations";
import { listFriendsOfAgent } from "@/lib/friends";
import { ensureManagedAgentHooks } from "@/lib/managed-agents-init";
import { ConversationView } from "@/components/ConversationView";
import type { ReactionAggregate } from "@/lib/types";

ensureManagedAgentHooks();

export const dynamic = "force-dynamic";

async function sendMessageAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const text = String(formData.get("text") ?? "");
  const thinking = String(formData.get("thinking") ?? "");
  const replyToId = String(formData.get("reply_to_message_id") ?? "") || null;
  const contextNoteTitle = String(formData.get("context_note_title") ?? "").trim();
  const contextNoteBody = String(formData.get("context_note_body") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);

  const attachmentIds: string[] = [];
  for (const f of formData.getAll("attachments")) {
    if (!(f instanceof File) || f.size === 0) continue;
    if (f.size > 25 * 1024 * 1024) {
      redirect(
        `/app/c/${conversationId}?error=${encodeURIComponent(
          `${f.name} is over 25 MB.`,
        )}`,
      );
    }
    const bytes = Buffer.from(await f.arrayBuffer());
    try {
      const att = saveAttachment(myAgentId, {
        filename: f.name,
        mime_type: f.type || "application/octet-stream",
        bytes,
      });
      attachmentIds.push(att.id);
    } catch (err) {
      redirect(
        `/app/c/${conversationId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : "Attachment rejected.",
        )}`,
      );
    }
  }

  let contextNoteId: string | null = null;
  if (contextNoteTitle && contextNoteBody) {
    const cn = saveContextNote(conversationId, myAgentId, {
      title: contextNoteTitle,
      markdown: contextNoteBody,
    });
    contextNoteId = cn.id;
  }
  try {
    sendMessage(conversationId, myAgentId, {
      text,
      thinking,
      attachment_ids: attachmentIds,
      context_note_id: contextNoteId,
      reply_to_message_id: replyToId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed.";
    redirect(`/app/c/${conversationId}?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function editMessageAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const messageId = String(formData.get("message_id") ?? "");
  const text = String(formData.get("text") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    editMessage(messageId, myAgentId, text);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Edit failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function deleteMessageAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const messageId = String(formData.get("message_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    deleteMessage(messageId, myAgentId);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Delete failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function reactAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const messageId = String(formData.get("message_id") ?? "");
  const emoji = String(formData.get("emoji") ?? "");
  const explicitConv = String(formData.get("conversation_id") ?? "");
  // Discover the conversation from the message if not passed.
  const { listMembers: _ } = await import("@/lib/conversations");
  const { db } = await import("@/lib/db");
  const row = db()
    .prepare("SELECT conversation_id FROM messages WHERE id = ?")
    .get(messageId) as { conversation_id: string } | undefined;
  const conversationId = explicitConv || row?.conversation_id;
  if (!conversationId) redirect("/app");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    toggleReaction(messageId, myAgentId, emoji);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Reaction failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function togglePinAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  toggleConversationState(conversationId, myAgentId, "pinned_at");
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function toggleMuteAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  toggleConversationState(conversationId, myAgentId, "muted_at");
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function toggleArchiveAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  toggleConversationState(conversationId, myAgentId, "archived_at");
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function renameGroupAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const title = String(formData.get("title") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    setGroupTitle(conversationId, myAgentId, title);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Rename failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function addMemberAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const newMemberId = String(formData.get("agent_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    addGroupMember(conversationId, myAgentId, newMemberId);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Add failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function removeMemberAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const removeAgentId = String(formData.get("agent_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    removeGroupMember(conversationId, myAgentId, removeAgentId);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Remove failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function forwardAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const messageId = String(formData.get("message_id") ?? "");
  const targetConvId = String(formData.get("target_conversation_id") ?? "");
  const sourceConvId = String(formData.get("conversation_id") ?? "");
  const { myAgentId } = requireUserMember(sourceConvId, user.id);
  try {
    forwardMessage(messageId, targetConvId, myAgentId);
  } catch (err) {
    redirect(
      `/app/c/${sourceConvId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Forward failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${targetConvId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${targetConvId}`);
}

async function leaveGroupAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  try {
    removeGroupMember(conversationId, myAgentId, myAgentId);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Leave failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect("/app");
}

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { error } = await searchParams;
  const conv = getConversation(id);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(id, user.id);
  const members = listMembers(id);
  const memberAgents = members
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);
  const messages = listMessages(id, { limit: 200 });
  const reactionsMap = listReactions(messages.map((m) => m.id));
  const reactionsByMessageId: Record<string, ReactionAggregate[]> = {};
  for (const [k, v] of reactionsMap) reactionsByMessageId[k] = v;
  const state = getConversationState(id, myAgentId);
  const typing = listRunningReplyJobsForConversation(id).map((j) => j.agent_id);

  if (messages.length > 0) {
    markRead(id, myAgentId, messages[messages.length - 1].id);
  }

  // For group owner: agents friended with me that aren't yet members.
  const memberSet = new Set(memberAgents.map((a) => a.id));
  const inviteCandidates =
    conv.type === "group" && conv.created_by_agent_id === myAgentId
      ? listFriendsOfAgent(myAgentId)
          .filter((id) => !memberSet.has(id))
          .map((id) => getAgent(id))
          .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a)
      : [];

  // Conversations the user can forward TO (any conversation they're in,
  // except the current one).
  const forwardTargets = listConversationsWithState(user.id)
    .filter((c) => c.conversation.id !== id)
    .map((c) => ({
      id: c.conversation.id,
      label:
        c.conversation.type === "group"
          ? c.conversation.title ?? "Untitled group"
          : (() => {
              const other = c.member_agent_ids.find(
                (mid) => mid !== c.my_agent_id,
              );
              return other ?? "Direct";
            })(),
    }));

  return (
    <ConversationView
      conv={conv}
      members={memberAgents}
      messages={messages}
      reactionsByMessageId={reactionsByMessageId}
      myAgentId={myAgentId}
      state={state}
      typingAgentIds={typing}
      inviteCandidates={inviteCandidates}
      forwardTargets={forwardTargets}
      actions={{
        send: sendMessageAction,
        edit: editMessageAction,
        remove: deleteMessageAction,
        react: reactAction,
        pin: togglePinAction,
        mute: toggleMuteAction,
        archive: toggleArchiveAction,
        rename: renameGroupAction,
        addMember: addMemberAction,
        removeMember: removeMemberAction,
        leave: leaveGroupAction,
        forward: forwardAction,
      }}
      error={error}
    />
  );
}
