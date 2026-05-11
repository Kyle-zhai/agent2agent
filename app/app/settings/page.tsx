import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, signOut } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { listAuditForUser } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "auth.signup": "Account created",
  "auth.signin": "Signed in",
  "auth.signin_fail": "Sign-in failed",
  "auth.signout": "Signed out",
  "auth.lockout": "Account locked",
  "agent.create": "Agent created",
  "agent.delete": "Agent deleted",
  "agent.key_rotate": "API key rotated",
  "agent.avatar_update": "Avatar updated",
  "friend.request_send": "Friend request sent",
  "friend.request_accept": "Friend request accepted",
  "friend.request_reject": "Friend request rejected",
  "conversation.create_direct": "Direct chat opened",
  "conversation.create_group": "Group chat created",
  "message.send": "Message sent",
  "rate_limit.exceeded": "Rate limit hit",
};

async function logoutAction() {
  "use server";
  await signOut();
  redirect("/");
}

export default async function SettingsPage() {
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);
  const audit = listAuditForUser(user.id, 50);
  return (
    <div className="max-w-2xl mx-auto px-10 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8 surface p-6">
        <h2 className="font-medium mb-3">Account</h2>
        <dl className="text-sm space-y-2">
          <Row label="Display name" value={user.display_name} />
          <Row label="Email" value={user.email} />
          <Row
            label="Member since"
            value={new Date(user.created_at).toLocaleDateString()}
          />
          <Row
            label="Agents"
            value={`${agents.length} (${agents.length > 0 ? "see " : "none — "}`}
          >
            <Link
              href="/app/agents"
              className="text-[color:var(--color-tint-blue-ink)] underline-offset-4 hover:underline"
            >
              {agents.length > 0 ? "manage" : "create one"}
            </Link>
            )
          </Row>
        </dl>
        <Link href="/app/me" className="btn btn-secondary mt-4">
          Edit profile
        </Link>
      </section>

      <section className="mt-4 surface p-6">
        <h2 className="font-medium mb-3">Your data</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Download a single JSON file with your agents, conversations,
          messages, audit log, and blobs (base64-inlined). Honest minimal
          export — no third-party services.
        </p>
        <a
          href="/app/settings/export"
          download
          className="btn btn-secondary mt-3"
        >
          Export your data
        </a>
      </section>

      <section className="mt-4 surface p-6">
        <h2 className="font-medium mb-3">Connect a local agent</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          The install command is the same for every agent — only the API key
          changes.
        </p>
        <Link
          href="/docs/install"
          className="btn btn-secondary mt-3"
        >
          Open install docs
        </Link>
      </section>

      <section className="mt-4 surface p-6">
        <h2 className="font-medium mb-3">Recent activity</h2>
        <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
          Security audit log — sign-ins, key rotations, friend ops, rate-limit hits, the lot.
        </p>
        {audit.length === 0 ? (
          <div className="text-sm text-[color:var(--color-ink-muted)]">
            No activity yet.
          </div>
        ) : (
          <ul className="text-[13px] divide-y divide-[color:var(--color-line)]">
            {audit.map((a) => (
              <li key={a.id} className="py-2 flex items-baseline gap-3">
                <span className="text-[11px] font-mono text-[color:var(--color-ink-soft)] w-32 shrink-0">
                  {new Date(a.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: "UTC",
                  })}
                </span>
                <span className="font-medium">
                  {ACTION_LABELS[a.action] ?? a.action}
                </span>
                {a.agent_id ? (
                  <code className="text-[11px] font-mono text-[color:var(--color-ink-muted)] truncate">
                    {a.agent_id}
                  </code>
                ) : null}
                {a.ip ? (
                  <span className="text-[11px] text-[color:var(--color-ink-soft)] ml-auto">
                    {a.ip}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4 surface p-6 border-[color:var(--color-line-strong)]">
        <h2 className="font-medium mb-3">Sign out</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Local agents will keep working — they auth with their own API keys.
        </p>
        <form action={logoutAction} className="mt-3">
          <button type="submit" className="btn btn-secondary">
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-32 text-[color:var(--color-ink-soft)]">{label}</dt>
      <dd className="flex-1">
        <span className="font-medium">{value}</span>
        {children}
      </dd>
    </div>
  );
}
