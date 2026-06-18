import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getAgent, listAgentsForUser } from "@/lib/agents";
import { listFriendsOfAgent } from "@/lib/friends";
import { createGroupConversation } from "@/lib/conversations";
import {
  createWorkspace,
  subscribeAgent,
} from "@/lib/workspaces";
import { createInvite } from "@/lib/invites";
import { CopyButton } from "@/components/CopyButton";

export const dynamic = "force-dynamic";

/**
 * /app/collab/new — single-page Notion-style wizard that wires up:
 *
 *   1. a group conversation (your agent + invited peer's agent)
 *   2. a shared workspace bound to it (both agents auto-subscribed as writers)
 *   3. (optional) an invite link if your teammate doesn't have an account yet
 *
 * After submit, you land in the group conversation, ready to compose a
 * handoff. The handoff lifecycle (lib/handoffs.ts) takes over from there.
 */

async function createCollabAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const projectName = String(formData.get("project_name") ?? "").trim();
  const myAgentId = String(formData.get("my_agent_id") ?? "");
  const peerAgentId = String(formData.get("peer_agent_id") ?? "");
  const inviteNote = String(formData.get("invite_note") ?? "").trim();

  if (!projectName) {
    redirect(
      `/app/collab/new?error=${encodeURIComponent("Project name is required.")}`,
    );
  }
  if (!myAgentId) {
    redirect(
      `/app/collab/new?error=${encodeURIComponent("Pick the assistant you'll use.")}`,
    );
  }

  // Branch A: a teammate's agent was picked → create group directly.
  if (peerAgentId) {
    let convId: string;
    let wsId: string;
    try {
      const conv = createGroupConversation(
        user.id,
        myAgentId,
        projectName.slice(0, 80),
        [peerAgentId],
      );
      convId = conv.id;
      const ws = createWorkspace({
        name: `${projectName.slice(0, 60)} files`,
        conversation_id: conv.id,
        created_by_agent_id: myAgentId,
      });
      wsId = ws.id;
      subscribeAgent(wsId, peerAgentId, "writer");
      logAudit("collab.create", {
        userId: user.id,
        agentId: myAgentId,
        detail: {
          conversation_id: convId,
          workspace_id: wsId,
          peer_agent_id: peerAgentId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create.";
      redirect(`/app/collab/new?error=${encodeURIComponent(msg)}`);
    }
    revalidatePath("/app", "layout");
    redirect(`/app/c/${convId}`);
  }

  // Branch B: no teammate yet → mint an invite link the user can share.
  // Note: keep the success-case redirect OUTSIDE the try/catch — redirect()
  // throws NEXT_REDIRECT internally, and a surrounding catch would treat
  // the redirect as a normal exception and double-redirect with an error.
  let inviteCode: string;
  try {
    const invite = createInvite({
      user_id: user.id,
      inviter_agent_id: myAgentId,
      note: inviteNote || `Join "${projectName}" collaboration`,
      max_uses: 1,
    });
    inviteCode = invite.code;
    logAudit("collab.invite", {
      userId: user.id,
      agentId: myAgentId,
      detail: { invite_id: invite.id, project_name: projectName },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create invite.";
    redirect(`/app/collab/new?error=${encodeURIComponent(msg)}`);
  }
  redirect(
    `/app/collab/new?step=share&code=${encodeURIComponent(inviteCode)}&name=${encodeURIComponent(projectName)}&agent=${encodeURIComponent(myAgentId)}`,
  );
}

export default async function CollabNewPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    step?: string;
    code?: string;
    name?: string;
    agent?: string;
  }>;
}) {
  const user = await requireUser();
  const { error, step, code, name, agent } = await searchParams;
  const myAgents = listAgentsForUser(user.id);
  if (myAgents.length === 0) {
    redirect(
      "/app/agents/new?error=" +
        encodeURIComponent(
          "Create your first assistant before starting a collaboration.",
        ),
    );
  }

  if (step === "share" && code) {
    return (
      <ShareStep
        code={code}
        projectName={name ?? "Collaboration"}
        myAgentId={agent ?? myAgents[0].id}
      />
    );
  }

  const friendsSet = new Set(
    myAgents.flatMap((a) => listFriendsOfAgent(a.id)),
  );
  const friendAgents = Array.from(friendsSet)
    .map((id) => getAgent(id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a)
    .filter((a) => a.owner_user_id !== user.id); // exclude my own

  return (
    <div className="app-stage">
      <nav className="text-[12px] text-[color:var(--color-ink-soft)] mb-2">
        <Link href="/app" className="hover:text-[color:var(--color-ink-muted)]">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <span>Start collaboration</span>
      </nav>
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Collaboration setup</div>
          <h1 className="page-title">Start a collaboration</h1>
          <p className="page-subtitle">
            Set up a shared room with your assistant, a teammate, and a file
            workspace in one step. Once both sides are in, hand off work with
            private context kept separate.
          </p>
        </div>
      </header>

      {error ? (
        <div className="callout callout-amber mt-6">
          <span className="text-lg">⚠️</span>
          <div className="text-[13px]">{error}</div>
        </div>
      ) : null}

      <div className="launch-layout">
        <aside className="step-rail">
          <div className="step-item is-active">
            <span className="step-dot">1</span>
            <div>
              <div className="text-[13px] font-semibold">Name the work</div>
              <p className="mt-1 text-[12px] leading-relaxed">
                This becomes the shared room and workspace label.
              </p>
            </div>
          </div>
          <div className="step-item">
            <span className="step-dot">2</span>
            <div>
              <div className="text-[13px] font-semibold">Choose people</div>
              <p className="mt-1 text-[12px] leading-relaxed">
                Pick your assistant and, optionally, a teammate.
              </p>
            </div>
          </div>
          <div className="step-item">
            <span className="step-dot">3</span>
            <div>
              <div className="text-[13px] font-semibold">Launch room</div>
              <p className="mt-1 text-[12px] leading-relaxed">
                Create the chat, workspace, and invite in one motion.
              </p>
            </div>
          </div>
        </aside>

        <form action={createCollabAction} className="launch-sheet">
          <Field
            label="Collaboration brief"
            hint="Use a working title, not a ticket number. It will be visible in the room and workspace."
          >
            <input
              type="text"
              name="project_name"
              required
              maxLength={80}
              placeholder="Onboarding email rewrite"
              className="input !text-[18px] !font-semibold"
              autoFocus
            />
          </Field>

          <Field
            label="Your side"
            hint="The assistant that represents you in this shared room."
          >
            <select
              name="my_agent_id"
              required
              defaultValue={myAgents[0].id}
              className="input font-mono !text-[13px]"
            >
              {myAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id} ·{" "}
                  {a.agent_kind === "managed" ? "hosted" : "connected"}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Teammate"
            hint={
              friendAgents.length === 0
                ? "No teammate in your directory yet? Leave this as an invite and send the link after launch."
                : "Pick a teammate's assistant, or leave this as an invite if they are not in your directory yet."
            }
          >
            <select
              name="peer_agent_id"
              defaultValue=""
              className="input font-mono !text-[13px]"
            >
              <option value="">Create an invite link instead</option>
              {friendAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Context for the invite"
            hint="This is only shown when you create an invite link."
          >
            <input
              type="text"
              name="invite_note"
              maxLength={280}
              placeholder="Need your help on Q3 retention"
              className="input"
            />
          </Field>

          <div className="launch-section flex items-center justify-between gap-3">
            <Link
              href="/app"
              className="text-[13px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink-muted)]"
            >
              Back to home
            </Link>
            <button type="submit" className="btn btn-primary">
              Launch collaboration
            </button>
          </div>
        </form>

        <aside className="module-panel p-5 launch-preview">
          <div className="page-kicker">Launch preview</div>
          <h2 className="mt-2 text-[18px] font-semibold tracking-tight">
            A room, workspace, and handoff lane
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-ink-muted)]">
            Agent2Agent will open a shared operating space and keep private
            assistant notes separate from teammate-visible work.
          </p>

          <div className="mt-5">
            <div className="preview-line">
              <span className="text-[color:var(--color-ink-soft)]">Room</span>
              <span className="font-medium">Group chat</span>
            </div>
            <div className="preview-line">
              <span className="text-[color:var(--color-ink-soft)]">Files</span>
              <span className="font-medium">Shared workspace</span>
            </div>
            <div className="preview-line">
              <span className="text-[color:var(--color-ink-soft)]">Access</span>
              <span className="font-medium">Writer for both assistants</span>
            </div>
            <div className="preview-line">
              <span className="text-[color:var(--color-ink-soft)]">Fallback</span>
              <span className="font-medium">Single-use invite</span>
            </div>
          </div>

          <div className="soft-divider" />

          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
            Next
          </div>
          <ul className="mt-3 space-y-3 text-[13px] leading-relaxed text-[color:var(--color-ink-muted)]">
            <li>1. The shared room opens immediately when a teammate is selected.</li>
            <li>2. If no teammate is selected, you get a polished invite link to send.</li>
            <li>3. Handoffs stay private-first until the recipient approves.</li>
          </ul>
        </aside>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="launch-section">
      <div className="launch-label">{label}</div>
      {children}
      {hint ? (
        <div className="text-[11.5px] text-[color:var(--color-ink-soft)] mt-1.5 leading-relaxed">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function ShareStep({
  code,
  projectName,
  myAgentId,
}: {
  code: string;
  projectName: string;
  myAgentId: string;
}) {
  const link = `/invite/${code}`;
  return (
    <div className="app-stage">
      <nav className="text-[12px] text-[color:var(--color-ink-soft)] mb-2">
        <Link href="/app" className="hover:text-[color:var(--color-ink-muted)]">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <Link
          href="/app/collab/new"
          className="hover:text-[color:var(--color-ink-muted)]"
        >
          Start collaboration
        </Link>
        <span className="mx-1.5">/</span>
        <span>Share invite</span>
      </nav>

      <div className="callout callout-green mb-6">
        <span className="text-lg">✅</span>
        <div>
          <div className="font-medium">Invite link ready</div>
          <p className="text-[13px] text-[color:var(--color-ink-muted)] mt-1">
            Send this link to your teammate. When they sign in and accept, they
            become a friend of <code className="font-mono">{myAgentId}</code>.
            Then you can pull them — and their assistant — into your shared
            room.
          </p>
        </div>
      </div>

      <div className="module-panel p-4">
        <div className="label">Share this link</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            defaultValue={link}
            className="input font-mono !text-[13px]"
          />
          <CopyButton value={link} label="Copy" />
        </div>
        <div className="text-[11.5px] text-[color:var(--color-ink-soft)] mt-2 leading-relaxed">
          The link expires in 7 days and is single-use.
        </div>
      </div>

      <div className="mt-8 module-panel p-5">
        <div className="text-[10px] uppercase tracking-wider font-medium text-[color:var(--color-ink-soft)] mb-2">
          Next steps
        </div>
        <ol className="text-[13px] text-[color:var(--color-ink)] leading-relaxed space-y-1.5 list-decimal pl-4">
          <li>Send the link to your teammate via your usual channel.</li>
          <li>After they sign up + accept, go to <Link href="/app/contacts" className="underline">Contacts</Link> to confirm they're a friend.</li>
          <li>Come back to <Link href="/app/collab/new" className="underline">/app/collab/new</Link> — they'll now appear in the teammate picker for <strong>{projectName}</strong>.</li>
        </ol>
      </div>

      <div className="flex items-center gap-2 mt-6">
        <Link href="/app" className="btn btn-secondary">
          Done
        </Link>
        <Link href="/app/collab/new" className="btn btn-ghost">
          Start another collaboration
        </Link>
      </div>
    </div>
  );
}
