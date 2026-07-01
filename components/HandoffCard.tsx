"use client";

import { useState } from "react";
import Link from "next/link";

export type HandoffCardData = {
  id: string;
  conversation_id: string;
  workspace_id: string | null;
  from_agent_id: string;
  from_user_id: string;
  to_agent_id: string;
  to_user_id: string;
  title: string;
  brief: string;
  shared_body: string;
  private_summary: string;
  redaction_count: number;
  task_id: string | null;
  status: "proposed" | "accepted" | "declined" | "withdrawn" | "completed";
  created_at: number;
  responded_at: number | null;
  response_note: string;
  /** The capability scope + duration being requested — surfaced as chips so
   *  the recipient sees exactly what they're about to grant. Optional so
   *  older callers that don't plumb them still typecheck. */
  scopes?: string[];
  duration_key?: string;
};

export type HandoffActorView =
  | "recipient" // viewer is the to_user — sees Accept / Decline
  | "sender"   // viewer is the from_user — sees status + withdraw
  | "observer"; // neither — read-only summary

/**
 * HandoffCard — the inline approval surface that renders inside the chat
 * stream. Two states matter visually:
 *   - proposed → big primary card with Accept / Decline (recipient) or
 *     waiting state (sender)
 *   - accepted / declined / withdrawn / completed → compact summary card
 */
export function HandoffCard({
  handoff,
  view,
  agentLabel,
  respondAction,
  withdrawAction,
  completeAction,
}: {
  handoff: HandoffCardData;
  view: HandoffActorView;
  agentLabel: { from: string; to: string };
  respondAction: (formData: FormData) => Promise<void>;
  withdrawAction: (formData: FormData) => Promise<void>;
  completeAction: (formData: FormData) => Promise<void>;
}) {
  const [showSummary, setShowSummary] = useState(true);
  const [decline, setDecline] = useState(false);

  const isProposed = handoff.status === "proposed";

  // Which actor the viewer is — makes the 3-viewpoint model legible. Honest,
  // non-interactive: it reflects the viewer's real identity (you can't act as
  // someone else), unlike the prototype's demo switcher.
  const viewLabel =
    view === "recipient"
      ? "Recipient · you"
      : view === "sender"
        ? "Sender · you"
        : "Observer";

  // The permission being requested, made legible up front. Raw scope names
  // render in plain words (read→view, write→edit, admin→manage) — display
  // only; the underlying scope values are unchanged.
  const scopeWords: Record<string, string> = {
    read: "view",
    comment: "comment",
    write: "edit",
    admin: "manage",
  };
  const scopeLabel =
    handoff.scopes && handoff.scopes.length > 0
      ? handoff.scopes.map((s) => scopeWords[s] ?? s).join(" + ")
      : null;
  const durationLabel = handoff.duration_key
    ? ({ "1h": "1h", "24h": "24h", "7d": "7d", forever: "no expiry" }[
        handoff.duration_key
      ] ?? handoff.duration_key)
    : null;

  const statusBadge =
    handoff.status === "proposed" ? (
      <span className="tag tag-amber">waiting for approval</span>
    ) : handoff.status === "accepted" ? (
      <span className="tag tag-green">accepted · working together</span>
    ) : handoff.status === "declined" ? (
      <span className="tag tag-pink">declined</span>
    ) : handoff.status === "withdrawn" ? (
      <span className="tag">withdrawn</span>
    ) : (
      <span className="tag tag-blue">completed</span>
    );

  return (
    <div
      className={
        "max-w-2xl mx-auto my-3 px-4 py-3.5 rounded-[var(--radius-card)] " +
        (isProposed
          ? "border border-[color:rgba(149,98,10,0.3)] shadow-[var(--shadow-pop)]"
          : "surface")
      }
      style={isProposed ? { background: "var(--grad-amber)" } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-ink-soft)] uppercase tracking-wider mb-1">
            <span>📨 Handoff</span>
            {statusBadge}
          </div>
          <div className="font-semibold text-[15px] tracking-tight leading-snug">
            {handoff.title}
          </div>
          <div className="text-[12px] text-[color:var(--color-ink-muted)] mt-0.5">
            <span className="font-mono">{agentLabel.from}</span>
            <span className="mx-1.5 text-[color:var(--color-ink-soft)]">→</span>
            <span className="font-mono">{agentLabel.to}</span>
          </div>
        </div>
        <span
          className="tag shrink-0 !py-0.5 !text-[10px]"
          title="The actions you see depend on whether you're the recipient, the sender, or just observing — same card, different viewpoints."
        >
          {viewLabel}
        </span>
      </div>

      {/* The permission being requested — scope + duration + workspace, made
          legible so the recipient knows exactly what they're granting. */}
      {scopeLabel || durationLabel || handoff.workspace_id ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {scopeLabel ? (
            <span className="tag tag-violet">🔑 can {scopeLabel}</span>
          ) : null}
          {durationLabel ? <span className="tag">⏱ {durationLabel}</span> : null}
          {handoff.workspace_id ? (
            <span className="tag tag-blue">📁 shared files</span>
          ) : null}
        </div>
      ) : null}

      {handoff.brief ? (
        <div className="mt-3 text-[13px] text-[color:var(--color-ink)] leading-relaxed">
          {handoff.brief}
        </div>
      ) : null}

      {handoff.shared_body ? (
        <details className="mt-3 group" open={isProposed}>
          <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink-muted)] select-none">
            What gets shared
          </summary>
          <pre className="mt-2 px-3 py-2 bg-[color:var(--color-canvas)] rounded-md text-[12.5px] font-mono whitespace-pre-wrap leading-relaxed border border-[color:var(--color-line)] max-h-[260px] overflow-auto">
            {handoff.shared_body}
          </pre>
        </details>
      ) : null}

      {handoff.redaction_count > 0 ? (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-[color:var(--color-ink-muted)]">
          <span className="tag tag-amber">
            🔒 {handoff.redaction_count} item{handoff.redaction_count === 1 ? "" : "s"} kept private
          </span>
          {view === "sender" && handoff.private_summary ? (
            <button
              type="button"
              onClick={() => setShowSummary((v) => !v)}
              className="underline-offset-2 hover:underline"
            >
              {showSummary ? "hide details" : "show details"}
            </button>
          ) : null}
        </div>
      ) : null}

      {view === "sender" &&
      handoff.private_summary &&
      handoff.redaction_count > 0 &&
      showSummary ? (
        <pre className="mt-2 px-3 py-2 text-[11.5px] font-mono whitespace-pre-wrap text-[color:var(--color-ink-muted)] bg-[color:var(--color-tint-amber)]/30 rounded-md border border-[color:var(--color-line)]">
          {handoff.private_summary}
        </pre>
      ) : null}

      {/* Accepted/Declined/Withdrawn footer — note + links */}
      {handoff.status !== "proposed" && handoff.response_note ? (
        <div className="mt-3 px-3 py-2 text-[12.5px] leading-relaxed bg-[color:var(--color-canvas)] rounded-md border border-[color:var(--color-line)]">
          <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mr-2">
            Note from {agentLabel.to.split(".")[0]}
          </span>
          {handoff.response_note}
        </div>
      ) : null}

      {handoff.status === "accepted" ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[12.5px]">
          {handoff.task_id ? (
            <Link
              href={`/app/c/${handoff.conversation_id}/tasks/${handoff.task_id}`}
              className="tag tag-green hover:bg-[color:var(--color-tint-green-ink)]/15"
            >
              ✅ Open the task
            </Link>
          ) : null}
          {handoff.workspace_id ? (
            <Link
              href={`/app?rail=files&conversation=${encodeURIComponent(
                handoff.conversation_id,
              )}&workspace=${encodeURIComponent(handoff.workspace_id)}`}
              className="tag tag-violet hover:bg-[color:var(--color-tint-violet-ink)]/15"
            >
              📁 Open the shared files
            </Link>
          ) : null}
          {view !== "observer" ? (
            // Least privilege: completing revokes the grants acceptance
            // minted (markHandoffCompleted). Either side may complete.
            <form action={completeAction} className="contents">
              <input type="hidden" name="handoff_id" value={handoff.id} />
              <input
                type="hidden"
                name="conversation_id"
                value={handoff.conversation_id}
              />
              <button
                type="submit"
                className="tag hover:bg-[color:var(--color-hover)]"
                title="Mark this done — the shared access is turned off"
              >
                ✓ Mark complete
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Action row */}
      {isProposed && view === "recipient" ? (
        decline ? (
          <form action={respondAction} className="mt-3 space-y-2">
            <input type="hidden" name="handoff_id" value={handoff.id} />
            <input type="hidden" name="conversation_id" value={handoff.conversation_id} />
            <input type="hidden" name="decision" value="decline" />
            <textarea
              name="note"
              placeholder="Tell them why you're declining (optional)…"
              className="input !text-[13px] min-h-[60px]"
              maxLength={600}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDecline(false)}
                className="btn btn-ghost btn-sm"
              >
                Back
              </button>
              <button type="submit" className="btn btn-danger btn-sm">
                Confirm decline
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <form action={respondAction} className="flex-1 flex items-center gap-2">
              <input type="hidden" name="handoff_id" value={handoff.id} />
              <input
                type="hidden"
                name="conversation_id"
                value={handoff.conversation_id}
              />
              <input type="hidden" name="decision" value="accept" />
              <input
                type="text"
                name="note"
                placeholder="(optional) add a note back"
                className="input !py-1.5 !text-[13px] flex-1"
                maxLength={600}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                ✅ Accept &amp; start
              </button>
            </form>
            <button
              type="button"
              onClick={() => setDecline(true)}
              className="btn btn-ghost btn-sm sm:w-auto"
            >
              Decline…
            </button>
          </div>
        )
      ) : null}

      {isProposed && view === "sender" ? (
        <div className="mt-3 flex items-center justify-between text-[12px] text-[color:var(--color-ink-soft)]">
          <span>Waiting for the other person to review…</span>
          <form action={withdrawAction}>
            <input type="hidden" name="handoff_id" value={handoff.id} />
            <input
              type="hidden"
              name="conversation_id"
              value={handoff.conversation_id}
            />
            <button type="submit" className="btn btn-ghost btn-sm">
              Withdraw
            </button>
          </form>
        </div>
      ) : null}

      {isProposed && view === "observer" ? (
        <div className="mt-3 text-[12px] text-[color:var(--color-ink-soft)] italic">
          Waiting for the recipient to review.
        </div>
      ) : null}
    </div>
  );
}
