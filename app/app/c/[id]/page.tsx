import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getAgent, listAgentsForUser } from "@/lib/agents";
import {
  addGroupMember,
  addOwnAgentToGroup,
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversation,
  getConversationState,
  getPersonaOverride,
  listConversationsWithState,
  listMembers,
  listMessages,
  listReactions,
  listRecentFailedReplyJobs,
  listRunningReplyJobsForConversation,
  markRead,
  removeGroupMember,
  requireUserMember,
  saveAttachment,
  saveContextNote,
  sendMessage,
  setGroupTitle,
  setPersonaOverride,
  toggleConversationState,
  toggleReaction,
} from "@/lib/conversations";
import { listFriendsOfAgent } from "@/lib/friends";
import {
  listLinksForConversation,
  requestAgentLink,
  respondAgentLink,
  revokeAgentLink,
} from "@/lib/agent-links";
import { listFiles, listWorkspacesForConversation } from "@/lib/workspaces";
import { listTasksForConversation } from "@/lib/tasks";
import { tryCreateTaskFromChat } from "@/lib/task-command";
import {
  listHandoffsForConversation,
  proposeHandoff,
  respondHandoff,
  markHandoffCompleted,
  withdrawHandoff,
} from "@/lib/handoffs";
import { getOwnAgentChannel } from "@/lib/own-agent-chat";
import { OwnAgentDock } from "@/components/OwnAgentDock";
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
          err instanceof Error ? err.message : "That file couldn't be attached.",
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
    // Chat-first task creation: "/task What needs doing @assistant" turns
    // into a real task instead of a chat message. Only an @-mentioned member
    // assistant is assigned (no @ → human note, no assistant acts). The raw
    // command is not posted — a plain confirmation is, so the room sees what
    // happened (and the @ in it nudges the assignee).
    const chatTask =
      attachmentIds.length === 0 && !contextNoteId && !replyToId
        ? tryCreateTaskFromChat({
            conversation_id: conversationId,
            author_agent_id: myAgentId,
            text,
          })
        : ({ handled: false } as const);
    sendMessage(conversationId, myAgentId, {
      text: chatTask.handled ? chatTask.confirmation : text,
      thinking,
      attachment_ids: attachmentIds,
      context_note_id: contextNoteId,
      reply_to_message_id: replyToId,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Couldn't send the message.";
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
        err instanceof Error ? err.message : "Couldn't save the edit.",
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
        err instanceof Error ? err.message : "Couldn't delete the message.",
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
        err instanceof Error ? err.message : "Couldn't add the reaction.",
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
        err instanceof Error ? err.message : "Couldn't rename the group.",
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
        err instanceof Error ? err.message : "Couldn't add that member.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function addOwnAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const myNewAgentId = String(formData.get("agent_id") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    addOwnAgentToGroup({
      conversation_id: conversationId,
      user_id: user.id,
      agent_id: myNewAgentId,
    });
    const { logAudit } = await import("@/lib/audit");
    logAudit("conversation.self_member_add", {
      userId: user.id,
      agentId: myNewAgentId,
      detail: { conversation_id: conversationId },
    });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't add your assistant.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function requestLinkAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const myAgent = String(formData.get("my_agent_id") ?? "");
  const theirAgent = String(formData.get("their_agent_id") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    requestAgentLink({
      conversation_id: conversationId,
      my_agent_id: myAgent,
      their_agent_id: theirAgent,
      initiating_user_id: user.id,
    });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error
          ? err.message
          : "Couldn't send the connection request.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function respondLinkAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const linkId = String(formData.get("link_id") ?? "");
  const decision = String(formData.get("decision") ?? "") as
    | "accept"
    | "decline";
  requireUserMember(conversationId, user.id);
  try {
    respondAgentLink({
      link_id: linkId,
      responding_user_id: user.id,
      decision,
    });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't save your response.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function revokeLinkAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const linkId = String(formData.get("link_id") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    revokeAgentLink({ link_id: linkId, user_id: user.id });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't remove the connection.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function removeMemberAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const removeAgentId = String(formData.get("agent_id") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);
  // v0.14 fix: if the user owns the agent being removed (multi-agent
  // user pulling out their second agent), use that agent as the actor so
  // removeGroupMember's self-remove path triggers — otherwise the lib's
  // owner-only check rejects.
  const target = getAgent(removeAgentId);
  const actorAgent =
    target && target.owner_user_id === user.id
      ? removeAgentId
      : myAgentId;
  try {
    removeGroupMember(conversationId, actorAgent, removeAgentId);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't remove that member.",
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
  const { myAgentId: sourceAgentId } = requireUserMember(sourceConvId, user.id);
  // The user may be in target conv via a DIFFERENT agent.
  let targetAgentId: string;
  try {
    targetAgentId = requireUserMember(targetConvId, user.id).myAgentId;
  } catch {
    redirect(
      `/app/c/${sourceConvId}?error=${encodeURIComponent(
        "You're not a member of that conversation.",
      )}`,
    );
  }
  try {
    forwardMessage(messageId, targetConvId, sourceAgentId, targetAgentId);
    const { logAudit } = await import("@/lib/audit");
    logAudit("message.forward", {
      userId: user.id,
      agentId: targetAgentId,
      detail: {
        message_id: messageId,
        from_conversation_id: sourceConvId,
        to_conversation_id: targetConvId,
      },
    });
  } catch (err) {
    redirect(
      `/app/c/${sourceConvId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't forward the message.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${targetConvId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${targetConvId}`);
}

async function setPersonaOverrideAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const agentId = String(formData.get("agent_id") ?? "");
  const persona = String(formData.get("persona") ?? "");
  // Caller must own the agent AND be a member of this conversation through
  // that agent.
  const owned = (await import("@/lib/agents")).getAgentOwnedBy(agentId, user.id);
  if (!owned) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent("That assistant isn't yours.")}`,
    );
  }
  try {
    setPersonaOverride(conversationId, agentId, persona);
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error
          ? err.message
          : "Couldn't save the instructions for this chat.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function proposeHandoffAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const fromAgentId = String(formData.get("from_agent_id") ?? "");
  const toAgentId = String(formData.get("to_agent_id") ?? "");
  const title = String(formData.get("title") ?? "");
  const brief = String(formData.get("brief") ?? "");
  const body = String(formData.get("body") ?? "");
  const workspaceId =
    String(formData.get("workspace_id") ?? "").trim() || null;
  // Scope and duration chips from the panel; the proposeHandoff layer
  // re-validates against the canonical lists.
  const scopes = formData
    .getAll("scopes")
    .map((v) => String(v))
    .filter((v): v is "read" | "comment" | "write" | "admin" =>
      ["read", "comment", "write", "admin"].includes(v),
    );
  const durationKey = String(formData.get("duration_key") ?? "24h");
  // Authorize: caller must be in conv via an agent they own; the from_agent
  // must be theirs too. requireUserMember validates membership.
  requireUserMember(conversationId, user.id);
  try {
    proposeHandoff({
      conversation_id: conversationId,
      from_user_id: user.id,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      title,
      brief,
      body,
      workspace_id: workspaceId,
      scopes: scopes.length > 0 ? scopes : undefined,
      duration_key: durationKey,
    });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't send the handoff.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function respondHandoffAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const handoffId = String(formData.get("handoff_id") ?? "");
  const decision = String(formData.get("decision") ?? "") as
    | "accept"
    | "decline";
  const note = String(formData.get("note") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    respondHandoff({
      handoff_id: handoffId,
      responding_user_id: user.id,
      decision,
      note,
    });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error
          ? err.message
          : "Couldn't save your response to the handoff.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function withdrawHandoffAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const handoffId = String(formData.get("handoff_id") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    withdrawHandoff({ handoff_id: handoffId, user_id: user.id });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't withdraw the handoff.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  redirect(`/app/c/${conversationId}`);
}

async function completeHandoffAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const handoffId = String(formData.get("handoff_id") ?? "");
  requireUserMember(conversationId, user.id);
  try {
    markHandoffCompleted({ handoff_id: handoffId, user_id: user.id });
  } catch (err) {
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(
        err instanceof Error
          ? err.message
          : "Couldn't mark the handoff as completed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
}

async function ownAgentSendAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const dockConvId = String(formData.get("conversation_id") ?? "");
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;
  // requireUserMember enforces that user actually owns one of the agents
  // in the dock conv (it'll be the external one we set up).
  const { myAgentId } = requireUserMember(dockConvId, user.id);
  try {
    sendMessage(dockConvId, myAgentId, { text });
  } catch (err) {
    // Surface back to the group conv URL since the dock has no error UI
    // surface of its own — the user is reading the main conv.
    redirect(
      `/app?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't send the message.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${dockConvId}`);
  revalidatePath("/app", "layout");
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
        err instanceof Error ? err.message : "Couldn't leave the group.",
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
  const recentFailures = listRecentFailedReplyJobs(id);

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

  // The user's managed agents that are members of THIS conversation —
  // they're eligible for a per-chat persona override.
  const myManagedAgentsInRoom = memberAgents.filter(
    (a) =>
      a.owner_user_id === user.id && a.agent_kind === "managed",
  );
  const personaOverrides: Record<string, string> = {};
  for (const a of myManagedAgentsInRoom) {
    const v = getPersonaOverride(id, a.id);
    if (v) personaOverrides[a.id] = v;
  }

  // v0.14: my agents NOT yet in this group (any group member can self-add).
  const memberIdSet = new Set(memberAgents.map((a) => a.id));
  const myAgentsForSelfAdd =
    conv.type === "group"
      ? listAgentsForUser(user.id).filter((a) => !memberIdSet.has(a.id))
      : [];

  // v0.14: all agent_links for this conversation (UI renders status badges).
  const agentLinks =
    conv.type === "group" ? listLinksForConversation(id) : [];

  // Workspace & task counts so the chat header's pills can show numbers.
  const workspaces = listWorkspacesForConversation(id);
  const workspaceFiles =
    workspaces[0]?.head_snapshot_id
      ? listFiles(workspaces[0].head_snapshot_id)
      : [];
  const tasks = listTasksForConversation(id);
  const openTaskCount = tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;

  // v0.15 — handoffs. Recipient picker = members owned by SOMEONE ELSE.
  // Sender (from_agent) defaults to "my preferred agent" (the same one
  // requireUserMember picked) but UI can swap if user has multiple.
  const handoffs = listHandoffsForConversation(id, 50);
  const handoffPeers = memberAgents
    .filter((a) => a.owner_user_id !== user.id)
    .map((a) => ({
      agent_id: a.id,
      agent_label: `${a.avatar_emoji} ${a.display_name}`,
      user_label: a.id.split(".").slice(0, 2).join("."),
    }));
  const handoffWorkspaceOptions = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
  }));

  // "Chat with my agent" left dock — only shown when the user has both an
  // external and a managed agent, AND we aren't already viewing the dock's
  // own 1:1 conversation (otherwise the dock would render itself nested
  // inside itself).
  const ownAgent = getOwnAgentChannel(user.id);
  const showDock = ownAgent && ownAgent.conversation_id !== id;

  return (
    <div className="flex gap-2.5 h-full">
      {/* The conversation list lives in the app shell on chat routes. This is
          the chat stage the floating own-agent window measures against. */}
      <div id="a2a-chat-stage" className="flex-1 min-w-0 h-full">
        <ConversationView
      conv={conv}
      members={memberAgents}
      messages={messages}
      reactionsByMessageId={reactionsByMessageId}
      myAgentId={myAgentId}
      myUserId={user.id}
      state={state}
      typingAgentIds={typing}
      recentFailures={recentFailures}
      inviteCandidates={inviteCandidates}
      myAgentsForSelfAdd={myAgentsForSelfAdd}
      agentLinks={agentLinks}
      workspaces={workspaces}
      workspaceFiles={workspaceFiles}
      tasks={tasks.slice(0, 5)}
      workspaceCount={workspaces.length}
      primaryWorkspaceId={workspaces[0]?.id ?? null}
      openTaskCount={openTaskCount}
      forwardTargets={forwardTargets}
      myManagedAgentsInRoom={myManagedAgentsInRoom}
      personaOverrides={personaOverrides}
      handoffs={handoffs.map((h) => ({
        id: h.id,
        conversation_id: h.conversation_id,
        workspace_id: h.workspace_id,
        from_agent_id: h.from_agent_id,
        from_user_id: h.from_user_id,
        to_agent_id: h.to_agent_id,
        to_user_id: h.to_user_id,
        title: h.title,
        brief: h.brief,
        shared_body: h.shared_body,
        private_summary: h.private_summary,
        redaction_count: h.redaction_count,
        task_id: h.task_id,
        status: h.status,
        created_at: h.created_at,
        responded_at: h.responded_at,
        response_note: h.response_note,
        scopes: (() => {
          try {
            const s = JSON.parse(h.scopes_json) as unknown;
            return Array.isArray(s) ? s.map(String) : [];
          } catch {
            return [];
          }
        })(),
        duration_key: h.duration_key,
      }))}
      handoffPeers={handoffPeers}
      handoffWorkspaces={handoffWorkspaceOptions}
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
        addOwnAgent: addOwnAgentAction,
        requestLink: requestLinkAction,
        respondLink: respondLinkAction,
        revokeLink: revokeLinkAction,
        removeMember: removeMemberAction,
        leave: leaveGroupAction,
        forward: forwardAction,
        setPersonaOverride: setPersonaOverrideAction,
        proposeHandoff: proposeHandoffAction,
        respondHandoff: respondHandoffAction,
        withdrawHandoff: withdrawHandoffAction,
        completeHandoff: completeHandoffAction,
      }}
      error={error}
        />
      </div>

      {/* Floating private 1:1 with the user's own managed agent — drag,
          resize, minimise, maximise, or close to a launcher pill; geometry
          persists across reloads. */}
      {showDock && ownAgent ? (
        <OwnAgentDock
          floating
          convId={ownAgent.conversation_id}
          myExternalAgentId={ownAgent.external_agent.id}
          managedAgent={ownAgent.managed_agent}
          messages={ownAgent.recent_messages}
          sendAction={ownAgentSendAction}
        />
      ) : null}
    </div>
  );
}
