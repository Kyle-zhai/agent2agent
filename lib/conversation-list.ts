import { listConversationsWithState } from "@/lib/conversations";
import { getAgent } from "@/lib/agents";
import type { ConversationListBundle } from "@/components/SidebarPanel";

/**
 * Build the sidebar conversation list (pinned / active / archived) plus the
 * unread total for a user. Shared by the app shell (`app/app/layout.tsx`) and
 * the conversation page, which folds the list into its middle column. Keeping
 * this in one place means the list is identical wherever it appears.
 */
export function getConversationListBundles(userId: string): {
  pinned: ConversationListBundle[];
  active: ConversationListBundle[];
  archived: ConversationListBundle[];
  unreadTotal: number;
} {
  const convs = listConversationsWithState(userId);

  // Enrich a row with the peer's emoji/name for the avatar tile, plus the
  // identity hints (managed → "bot", a different owner → "external").
  const enrich = (c: (typeof convs)[number]): ConversationListBundle => {
    const peerTags: Array<"bot" | "external"> = [];
    if (c.conversation.type === "direct") {
      const otherId = c.member_agent_ids.find((id) => id !== c.my_agent_id);
      const other = otherId ? getAgent(otherId) : null;
      if (other) {
        if (other.agent_kind === "managed") peerTags.push("bot");
        if (other.owner_user_id !== userId) peerTags.push("external");
      }
    }
    return {
      ...c,
      member_emojis: c.member_agent_ids.map(
        (id) => getAgent(id)?.avatar_emoji ?? "🤖",
      ),
      member_names: c.member_agent_ids.map(
        (id) => getAgent(id)?.display_name ?? id,
      ),
      peer_tags: peerTags,
    };
  };

  const pinned = convs
    .filter((c) => c.state.pinned_at && !c.state.archived_at)
    .sort((a, b) => (b.state.pinned_at ?? 0) - (a.state.pinned_at ?? 0))
    .map(enrich);
  const active = convs
    .filter((c) => !c.state.pinned_at && !c.state.archived_at)
    .sort(
      (a, b) =>
        (b.last_message?.created_at ?? 0) - (a.last_message?.created_at ?? 0),
    )
    .map(enrich);
  const archived = convs.filter((c) => c.state.archived_at).map(enrich);
  const unreadTotal = convs
    .filter((c) => !c.state.muted_at)
    .reduce((sum, c) => sum + c.unread_count, 0);

  return { pinned, active, archived, unreadTotal };
}
