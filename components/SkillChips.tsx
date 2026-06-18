"use client";

// SkillChips — one-click quick prompts that replace typing.
//
// Each member of the conversation publishes an A2A AgentCard with
// `skills[]`. We render those skills as chips above the composer; clicking
// one stuffs the textarea (passed by `targetRef`) with a ready-to-send
// prompt that mentions the agent. The user can edit or just hit send.
//
// We intentionally do NOT auto-submit — the human still reviews. The point
// is to skip typing "@alice please draft …", not to remove the approval
// step.

import { useEffect, useState } from "react";

export type SkillChip = {
  agent_id: string;
  agent_label: string;
  agent_emoji: string;
  skill_id: string;
  skill_name: string;
  example: string;
};

export function SkillChips({
  members,
  myAgentId,
  fetchUrl,
  onPick,
}: {
  members: Array<{ id: string; display_name: string; avatar_emoji: string }>;
  myAgentId: string;
  /** Optional override; defaults to the spec-compliant AgentCard URL. */
  fetchUrl?: (agentId: string) => string;
  onPick: (text: string) => void;
}) {
  const [chips, setChips] = useState<SkillChip[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const peers = members.filter((m) => m.id !== myAgentId);
    if (peers.length === 0) return;

    Promise.allSettled(
      peers.map(async (m) => {
        const url = fetchUrl
          ? fetchUrl(m.id)
          : `/api/v1/agents/${encodeURIComponent(m.id)}/.well-known/agent-card.json`;
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) return [];
        const card = (await r.json()) as {
          skills?: Array<{
            id: string;
            name: string;
            description: string;
            examples?: string[];
          }>;
        };
        const out: SkillChip[] = [];
        for (const s of card.skills ?? []) {
          const example =
            (s.examples ?? []).find((e) => typeof e === "string") ??
            `Use the ${s.name} skill on @${m.id.split(".")[0]}`;
          out.push({
            agent_id: m.id,
            agent_label: m.display_name,
            agent_emoji: m.avatar_emoji,
            skill_id: s.id,
            skill_name: s.name,
            example,
          });
        }
        return out;
      }),
    ).then((results) => {
      if (cancelled) return;
      const merged: SkillChip[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") merged.push(...r.value);
      }
      // Cap the visible chips so the composer doesn't grow unbounded with
      // big rooms. We rank by: skip the catch-all "chat" skill once we
      // have ≥1 declared skill for the same agent.
      const byAgent = new Map<string, SkillChip[]>();
      for (const c of merged) {
        const list = byAgent.get(c.agent_id) ?? [];
        list.push(c);
        byAgent.set(c.agent_id, list);
      }
      const filtered: SkillChip[] = [];
      for (const list of byAgent.values()) {
        const real = list.filter((c) => c.skill_id !== "chat");
        if (real.length > 0) filtered.push(...real.slice(0, 2));
        else filtered.push(...list.slice(0, 1));
      }
      setChips(filtered.slice(0, 8));
    });
    return () => {
      cancelled = true;
    };
    // Depend on a stable key of peer ids, not the `members` array identity:
    // ConversationView rebuilds `members` on every SSE-driven router.refresh(),
    // so depending on the array would refetch every peer's agent-card.json on
    // each refresh (network traffic scaling with room size × refresh rate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.filter((m) => m.id !== myAgentId).map((m) => m.id).join(","), fetchUrl]);

  if (chips.length === 0) return null;
  if (collapsed) {
    return (
      <div className="px-3 pb-1">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="text-[11px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink-muted)] underline-offset-4 hover:underline"
        >
          ⚡ Show quick actions ({chips.length})
        </button>
      </div>
    );
  }
  return (
    <div className="px-3 pt-1.5 pb-1 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mr-1">
        ⚡ Quick actions
      </span>
      {chips.map((c) => (
        <button
          key={`${c.agent_id}/${c.skill_id}`}
          type="button"
          onClick={() =>
            onPick(`@${c.agent_id.split(".")[0]} ${c.example}`)
          }
          title={`${c.skill_name} — a skill this assistant offers`}
          className="tag hover:bg-[color:var(--color-tint-violet)] cursor-pointer transition-colors"
        >
          <span className="mr-1">{c.agent_emoji}</span>
          {c.skill_name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        title="Hide quick actions"
        className="ml-auto text-[10px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink-muted)]"
      >
        Hide
      </button>
    </div>
  );
}
