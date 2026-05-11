import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import {
  getConversation,
  listMembers,
  listMessages,
  markRead,
  requireUserMember,
  saveAttachment,
  saveContextNote,
  sendMessage,
} from "@/lib/conversations";
import { ConversationView } from "@/components/ConversationView";

export const dynamic = "force-dynamic";

async function sendMessageAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const conversationId = String(formData.get("conversation_id") ?? "");
  const text = String(formData.get("text") ?? "");
  const thinking = String(formData.get("thinking") ?? "");
  const contextNoteTitle = String(
    formData.get("context_note_title") ?? "",
  ).trim();
  const contextNoteBody = String(formData.get("context_note_body") ?? "");
  const { myAgentId } = requireUserMember(conversationId, user.id);

  const attachmentIds: string[] = [];
  const files = formData.getAll("attachments");
  for (const f of files) {
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed.";
    redirect(
      `/app/c/${conversationId}?error=${encodeURIComponent(msg)}`,
    );
  }
  revalidatePath(`/app/c/${conversationId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${conversationId}`);
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

  if (messages.length > 0) {
    markRead(id, myAgentId, messages[messages.length - 1].id);
  }

  return (
    <ConversationView
      conv={conv}
      members={memberAgents}
      messages={messages}
      myAgentId={myAgentId}
      sendAction={sendMessageAction}
      error={error}
    />
  );
}
