"use client";

import { useMemo, useRef, useState } from "react";

export type HandoffPeerOption = {
  agent_id: string;
  agent_label: string;
  user_label: string;
};

export type HandoffWorkspaceOption = {
  id: string;
  name: string;
};

/**
 * HandoffPanel — the composer User1 uses to package content for User2's agent.
 *
 * Live filter preview mirrors lib/handoffs.ts#filterPrivateContent so the
 * sender always knows what their agent will (or won't) pass along before
 * hitting "Send to peer". Markers supported by the preview:
 *
 *   [[private]] one-liner    →  redacted up to end of line
 *   [[private]] ... [[/private]]  →  block redaction
 *   {{private: ...}}         →  inline redaction
 *   > private: ...           →  whole-line redaction (also "# private:")
 *
 * Plus heuristic auto-redaction for lines containing phrases like
 * "do not share", "internal only", "confidential".
 *
 * The preview is intentionally a near-exact JS port of the server-side
 * filter — if the server changes its rules, mirror them here so the user
 * never sees a different preview from what actually ships.
 */

const REDACTION_PLACEHOLDER = "〈hidden by your assistant〉";

const HEURISTICS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bdo not share\b/i, reason: "do not share" },
  { re: /\bdon't share\b/i, reason: "don't share" },
  { re: /\binternal only\b/i, reason: "internal only" },
  { re: /\bconfidential\b/i, reason: "confidential" },
  { re: /\bnot for sharing\b/i, reason: "not for sharing" },
  { re: /\bsecret:/i, reason: "secret:" },
];

type Preview = {
  shared: string;
  hidden: number;
  reasons: string[];
};

function previewFilter(input: string): Preview {
  const reasons: string[] = [];
  let text = input;

  text = text.replace(/\[\[private\]\]([\s\S]*?)\[\[\/private\]\]/gi, () => {
    reasons.push("[[private]] block");
    return REDACTION_PLACEHOLDER;
  });
  text = text.replace(/\{\{\s*private\s*:\s*([\s\S]*?)\}\}/gi, () => {
    reasons.push("{{private:}} inline");
    return REDACTION_PLACEHOLDER;
  });
  text = text.replace(/\[\[private\]\][^\n]*/gi, () => {
    reasons.push("[[private]] one-liner");
    return REDACTION_PLACEHOLDER;
  });
  text = text.replace(/^[ \t]*[>#]\s*private\s*:[^\n]*/gim, () => {
    reasons.push("private: line");
    return REDACTION_PLACEHOLDER;
  });

  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(REDACTION_PLACEHOLDER)) {
      lines.push(line);
      continue;
    }
    let matched = false;
    for (const h of HEURISTICS) {
      if (h.re.test(line)) {
        reasons.push(h.reason);
        lines.push(REDACTION_PLACEHOLDER);
        matched = true;
        break;
      }
    }
    if (!matched) lines.push(line);
  }
  return {
    shared: lines.join("\n").trim(),
    hidden: reasons.length,
    reasons,
  };
}

export function HandoffPanel({
  convId,
  myAgentId,
  peers,
  workspaces,
  proposeAction,
  onClose,
}: {
  convId: string;
  myAgentId: string;
  peers: HandoffPeerOption[];
  workspaces: HandoffWorkspaceOption[];
  proposeAction: (formData: FormData) => Promise<void>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(peers[0]?.agent_id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [body, setBody] = useState("");
  // Scope preset — least-privilege defaults. Three buckets cover the
  // realistic permission ladder: Look (read-only), Discuss (can comment),
  // Co-edit (can write). We avoid exposing the raw scope checkbox grid
  // because the spec already documents that ladder; chips are clearer.
  const [scopePreset, setScopePreset] = useState<"look" | "discuss" | "coedit">(
    "discuss",
  );
  const [durationKey, setDurationKey] = useState<"1h" | "24h" | "7d" | "forever">(
    "24h",
  );
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const scopesForPreset: Record<typeof scopePreset, string[]> = {
    look: ["read"],
    discuss: ["read", "comment"],
    coedit: ["read", "comment", "write"],
  };

  const preview = useMemo(() => previewFilter(body), [body]);

  // Plain-language summary of the permission decision (mirrors the chips).
  const scopeTechLabel = {
    look: "view",
    discuss: "view and comment",
    coedit: "view, comment, and edit",
  }[scopePreset];
  const durationLabel = {
    "1h": "1h",
    "24h": "24h",
    "7d": "7d",
    forever: "never",
  }[durationKey];
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId);

  // One-click "wrap selected text in [[private]]…[[/private]]" so the user
  // never has to memorise the marker syntax. If no text is selected, we
  // insert an empty pair at the caret so the cursor lands inside it.
  function wrapSelectionPrivate() {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const before = body.slice(0, start);
    const middle = body.slice(start, end);
    const after = body.slice(end);
    const wrapped =
      `${before}[[private]]${middle || " "}[[/private]]${after}`;
    setBody(wrapped);
    // Restore selection inside the new wrapper on the next tick.
    requestAnimationFrame(() => {
      if (!el) return;
      const openLen = "[[private]]".length;
      const inner = middle || " ";
      el.focus();
      el.setSelectionRange(start + openLen, start + openLen + inner.length);
    });
  }

  if (peers.length === 0) {
    return (
      <div className="surface p-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm">Hand off to a friend's assistant</h3>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
        <p className="text-[13px] text-[color:var(--color-ink-muted)] leading-relaxed">
          No one else's assistant is in this room yet. Invite a friend's
          assistant (or have them add their own) to start handing work off.
        </p>
      </div>
    );
  }

  return (
    <div className="surface p-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-[15px] tracking-tight">
            Hand off to a friend's assistant
          </h3>
          <p className="text-[12px] text-[color:var(--color-ink-soft)] mt-0.5">
            Anything you mark private stays with you — only the rest is sent.
            The other person approves before their assistant starts.
          </p>
        </div>
        <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>

      <form action={proposeAction} className="space-y-3">
        <input type="hidden" name="conversation_id" value={convId} />
        <input type="hidden" name="from_agent_id" value={myAgentId} />
        {/* Pre-baked scope + duration travel into the handoff row and
            then into the signed grant minted on accept. Server
            re-validates against ALL_SCOPES / DURATION_PRESETS so a
            forged value can't escalate. */}
        {scopesForPreset[scopePreset].map((s) => (
          <input key={s} type="hidden" name="scopes" value={s} />
        ))}
        <input type="hidden" name="duration_key" value={durationKey} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="label">Send to</div>
            {/* Hidden field carries the value; chip row replaces the
                <select> so the user picks with one click instead of
                opening a dropdown. */}
            <input type="hidden" name="to_agent_id" value={target} required />
            <div
              role="radiogroup"
              aria-label="Send to"
              className="flex flex-wrap gap-1.5"
            >
              {peers.map((p) => {
                const active = p.agent_id === target;
                return (
                  <button
                    key={p.agent_id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTarget(p.agent_id)}
                    title={p.user_label}
                    className={
                      "px-2 py-1 rounded-md text-[12px] border transition-colors " +
                      (active
                        ? "bg-[color:var(--color-ink)] border-[color:var(--color-ink)] text-white"
                        : "bg-transparent border-[color:var(--color-line)] hover:bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]")
                    }
                  >
                    {p.agent_label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="label">Shared files</div>
            {workspaces.length === 0 ? (
              <div className="text-[12px] text-[color:var(--color-ink-soft)] italic px-1 py-2">
                No shared file area yet. Create one under{" "}
                <strong>📁 Files</strong> first if you want to share files with
                this handoff.
              </div>
            ) : (
              <select
                name="workspace_id"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="input !py-1.5 !text-[13px]"
              >
                <option value="">(no shared files)</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    📁 {w.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Permission decision — scope + duration grouped as ONE deliberate
            choice, with a plain-language summary of exactly what gets granted
            so the sender never feels "I don't know what I gave away". */}
        <div className="rounded-[var(--radius-card)] border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] p-3.5 space-y-3">
          <div className="flex items-center gap-1.5">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[color:var(--color-tint-violet-ink)]"
              aria-hidden
            >
              <circle cx="8" cy="14" r="4.5" />
              <path d="m11.5 11 8-8" />
              <path d="m16 6.5 2.5 2.5" />
              <path d="m19 4 2 2" />
            </svg>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-tint-violet-ink)]">
              Access
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="label">What they can do</div>
              <div role="radiogroup" aria-label="What they can do" className="flex gap-1.5">
                {([
                  { key: "look", label: "👀 Look", help: "Can view" },
                  { key: "discuss", label: "💬 Discuss", help: "Can view and comment" },
                  { key: "coedit", label: "✍️ Co-edit", help: "Can view, comment, and edit together" },
                ] as const).map((opt) => {
                  const active = scopePreset === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={opt.help}
                      onClick={() => setScopePreset(opt.key)}
                      className={
                        "flex-1 px-2 py-1 rounded-md text-[12px] border transition-colors " +
                        (active
                          ? "bg-[color:var(--color-ink)] border-[color:var(--color-ink)] text-white"
                          : "bg-[color:var(--color-paper)] border-[color:var(--color-line)] hover:bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]")
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="label">Expires in</div>
              <div role="radiogroup" aria-label="Expires in" className="flex gap-1.5">
                {([
                  { key: "1h", label: "1h" },
                  { key: "24h", label: "24h" },
                  { key: "7d", label: "7d" },
                  { key: "forever", label: "Never" },
                ] as const).map((opt) => {
                  const active = durationKey === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setDurationKey(opt.key)}
                      className={
                        "flex-1 px-2 py-1 rounded-md text-[12px] border transition-colors " +
                        (active
                          ? "bg-[color:var(--color-ink)] border-[color:var(--color-ink)] text-white"
                          : "bg-[color:var(--color-paper)] border-[color:var(--color-line)] hover:bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]")
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="callout callout-blue items-center !py-2 !px-3">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[color:var(--color-tint-blue-ink)]"
              aria-hidden
            >
              <path d="M12 3 5 5.5V11c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V5.5Z" />
            </svg>
            <span className="text-[12px] leading-relaxed text-[color:var(--color-tint-blue-ink)]">
              You&rsquo;re sharing access: they can <strong>{scopeTechLabel}</strong> in{" "}
              <strong>{selectedWorkspace ? selectedWorkspace.name : "this conversation"}</strong>
              , expiring{" "}
              <strong>{durationLabel === "never" ? "never" : `in ${durationLabel}`}</strong>.
              You can turn this off any time.
            </span>
          </div>
        </div>

        <div>
          <div className="label">Title</div>
          <input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Help me draft the onboarding email"
            className="input"
            required
            maxLength={120}
          />
        </div>

        <div>
          <div className="label">Quick summary (one paragraph)</div>
          <textarea
            name="brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="What the other assistant should know up front."
            className="input min-h-[60px] !text-[13px] leading-relaxed"
            maxLength={600}
          />
        </div>

        <div>
          <div className="label flex items-center justify-between">
            <span>Draft</span>
            <button
              type="button"
              onClick={wrapSelectionPrivate}
              title="Select text first, then click — wraps it in [[private]] markers so only YOU see it."
              className="text-[10px] tracking-normal normal-case px-2 py-0.5 rounded-md border border-[color:var(--color-line)] hover:bg-[color:var(--color-tint-amber)] text-[color:var(--color-ink-muted)] font-medium"
            >
              🔒 Mark selection private
            </button>
          </div>
          <textarea
            ref={bodyRef}
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              "Write everything you'd say to your own assistant. Select any\n" +
              "sentence and tap 🔒 to keep it private — the preview below\n" +
              "shows what the other side will actually see."
            }
            className="input min-h-[180px] font-mono !text-[12.5px] leading-relaxed"
            maxLength={16000}
            required
          />
        </div>

        <div className="border rounded-[var(--radius-card)] border-[color:var(--color-line)] overflow-hidden">
          <div className="px-3 py-2 bg-[color:var(--color-canvas)] border-b border-[color:var(--color-line)] flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-ink-muted)]">
              Preview — what they&rsquo;ll see
            </span>
            <span
              className={
                preview.hidden > 0
                  ? "tag tag-amber"
                  : "tag tag-green"
              }
            >
              {preview.hidden === 0
                ? "✓ Nothing hidden"
                : `${preview.hidden} kept private`}
            </span>
          </div>
          <pre className="px-3 py-2 text-[12.5px] font-mono whitespace-pre-wrap max-h-[200px] overflow-auto bg-[color:var(--color-paper)]">
            {preview.shared || (
              <span className="text-[color:var(--color-ink-soft)] italic">
                (what you share will appear here as you type)
              </span>
            )}
          </pre>
          {preview.hidden > 0 ? (
            <div className="px-3 py-2 bg-[color:var(--color-tint-amber)]/40 border-t border-[color:var(--color-line)] text-[11.5px] text-[color:var(--color-ink-muted)]">
              <strong className="font-semibold">Hidden:</strong>{" "}
              {Array.from(new Set(preview.reasons)).map((r, i, arr) => (
                <span key={r}>
                  {r}
                  {i < arr.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-[color:var(--color-ink-soft)]">
            The other person approves before their assistant starts.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm">
              📨 Send for review
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
