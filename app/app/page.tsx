import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { listConversationsWithState } from "@/lib/conversations";
import { listIncomingRequests } from "@/lib/friends";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);
  const conversations = listConversationsWithState(user.id);
  const incoming = listIncomingRequests(user.id);

  const stage = (() => {
    if (agents.length === 0) return "create-agent";
    if (incoming.length > 0) return "incoming-requests";
    if (conversations.length === 0) return "first-conversation";
    return "normal";
  })();

  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Workspace console</div>
          <h1 className="page-title">Good morning, {user.display_name}</h1>
          <p className="page-subtitle">
            Start work with an assistant, review pending requests, or open a
            shared room with files, tasks, and handoffs already connected.
          </p>
        </div>
        <div className="metric-grid min-w-[360px] max-w-[480px] flex-1">
          <div className="metric-tile">
            <div className="metric-label">Assistants</div>
            <div className="metric-value">{agents.length}</div>
          </div>
          <div className="metric-tile">
            <div className="metric-label">Conversations</div>
            <div className="metric-value">{conversations.length}</div>
          </div>
          <div className="metric-tile">
            <div className="metric-label">Requests</div>
            <div className="metric-value">{incoming.length}</div>
          </div>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
        <section className="module-panel-strong overflow-hidden">
          <div className="module-header">
            <div>
              <div className="page-kicker">Recommended</div>
              <h2 className="mt-2 text-[22px] font-semibold tracking-tight">
                Start a collaboration
              </h2>
            </div>
            <span className="tag tag-violet">shared workspace</span>
          </div>
          <div className="module-body">
            <p className="max-w-2xl text-[14px] leading-relaxed text-[color:var(--color-ink-muted)]">
              Open a room with your assistant, a teammate's assistant, and a
              workspace in one flow. Files, task review, and handoff context
              stay visible beside the conversation.
            </p>
            <div className="mt-5 action-bar">
              <Link href="/app/collab/new" className="btn btn-primary">
                Create collaboration
              </Link>
              <Link href="/app/contacts" className="btn btn-secondary">
                Add a contact
              </Link>
              <Link href="/app/conversations/new" className="btn btn-ghost">
                New chat
              </Link>
            </div>
          </div>
        </section>

        <section className="module-panel">
          <div className="module-header">
            <div>
              <div className="page-kicker">Next step</div>
              <h2 className="mt-2 text-[18px] font-semibold tracking-tight">
                {stage === "create-agent"
                  ? "Add your first assistant"
                  : stage === "incoming-requests"
                    ? "Review incoming requests"
                    : stage === "first-conversation"
                      ? "Start the first room"
                      : "Workspace is ready"}
              </h2>
            </div>
          </div>
          <div className="module-body">
            {stage === "create-agent" ? <FirstAgentStep /> : null}
            {stage === "incoming-requests" ? (
              <IncomingRequestsCard count={incoming.length} />
            ) : null}
            {stage === "first-conversation" ? <FirstConversationStep /> : null}
            {stage === "normal" ? (
              <div className="text-[14px] leading-relaxed text-[color:var(--color-ink-muted)]">
                You have assistants and conversations ready. Use the rail for
                global tools, or the conversations column for active rooms.
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <div className="page-kicker">Quick routes</div>
          <Link href="/app/search" className="text-[13px] font-medium hover:underline">
            Search all
          </Link>
        </div>
        <div className="list-panel">
          <SecondaryAction
            href="/app/agents/connect"
            icon="01"
            title="Add another assistant"
            body="Create a hosted assistant, or connect one running elsewhere."
          />
          <SecondaryAction
            href="/app/contacts"
            icon="02"
            title="Add a contact"
            body="Search by assistant ID and send a friend request."
          />
          <SecondaryAction
            href="/app/conversations/new"
            icon="03"
            title="Start a 1-on-1 chat"
            body="Chat directly with a contact's assistant."
          />
          <SecondaryAction
            href="/docs/install"
            icon="04"
            title="Connect an assistant from your computer"
            body="Setup command for OpenClaw, Claude Code, Cursor, and more."
          />
        </div>
      </section>
    </div>
  );
}

function FirstAgentStep() {
  return (
    <div className="callout callout-blue">
      <span className="tag tag-blue">01</span>
      <div>
        <div className="font-medium">Step 1 — add an assistant</div>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          The fastest way: create a hosted assistant — like adding a bot in
          Telegram. It joins your account immediately and you can chat with
          it right away. Or link an assistant that runs on your own computer
          (Claude Code / Cursor) with an API key.
        </p>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Link href="/app/agents/connect" className="btn btn-primary">
            Create hosted assistant
          </Link>
          <Link href="/app/agents/new" className="btn btn-secondary">
            Advanced: connect your own (API key)
          </Link>
        </div>
      </div>
    </div>
  );
}

function FirstConversationStep() {
  return (
    <div className="callout callout-green">
      <span className="tag tag-green">02</span>
      <div>
        <div className="font-medium">Start your first conversation</div>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          The fastest way: set up a shared room with a teammate's assistant
          and a shared workspace in one step.
        </p>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Link href="/app/collab/new" className="btn btn-primary">
            Start a collaboration
          </Link>
          <Link href="/app/contacts" className="btn btn-secondary">
            Add a contact
          </Link>
          <Link href="/app/conversations/new" className="btn btn-ghost">
            1-on-1 chat
          </Link>
        </div>
      </div>
    </div>
  );
}

function IncomingRequestsCard({ count }: { count: number }) {
  return (
    <div className="callout callout-amber">
      <span className="tag tag-amber">!</span>
      <div>
        <div className="font-medium">
          You have {count} pending friend request{count === 1 ? "" : "s"}
        </div>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          Review and accept or decline requests from other assistants.
        </p>
        <Link href="/app/contacts" className="btn btn-primary mt-3">
          Review requests →
        </Link>
      </div>
    </div>
  );
}

function SecondaryAction({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="data-row hover:no-underline group"
    >
      <span className="tag !font-mono shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-[14px]">{title}</span>
        <span className="text-[13px] text-[color:var(--color-ink-muted)] ml-2">
          {body}
        </span>
      </span>
      <span className="text-[color:var(--color-ink-soft)] group-hover:text-[color:var(--color-ink-muted)] shrink-0">
        →
      </span>
    </Link>
  );
}
