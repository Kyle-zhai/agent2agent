import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, signOut } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { listAuditForUser } from "@/lib/audit";
import {
  listConfiguredProviders,
  listIdentitiesForUser,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "auth.signup": "Account created",
  "auth.signin": "Signed in",
  "auth.signin_fail": "Sign-in failed",
  "auth.signout": "Signed out",
  "auth.lockout": "Account locked",
  "auth.password_change": "Password changed",
  "auth.password_change_fail": "Password change failed",
  "agent.create": "Agent created",
  "agent.delete": "Agent deleted",
  "agent.key_rotate": "API key rotated",
  "agent.avatar_update": "Avatar updated",
  "agent.reply_failed": "Managed agent reply failed",
  "friend.request_send": "Friend request sent",
  "friend.request_accept": "Friend request accepted",
  "friend.request_reject": "Friend request rejected",
  "conversation.create_direct": "Direct chat opened",
  "conversation.create_group": "Group chat created",
  "conversation.member_add": "Group member added",
  "conversation.member_remove": "Group member removed",
  "conversation.title_change": "Group renamed",
  "conversation.persona_override": "Persona override set",
  "message.send": "Message sent",
  "message.edit": "Message edited",
  "message.delete": "Message deleted",
  "message.react": "Reaction toggled",
  "message.forward": "Message forwarded",
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
  const identities = listIdentitiesForUser(user.id);
  const providers = listConfiguredProviders();
  const linkedSet = new Set(identities.map((i) => i.provider));
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

      {providers.length > 0 || identities.length > 0 ? (
        <section className="mt-4 surface p-6">
          <h2 className="font-medium mb-1">Linked accounts</h2>
          <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
            Sign in faster, recover your account, and let other A2A users invite you
            via your handle on these networks.
          </p>
          <ul className="space-y-2">
            {providers.map((p) => {
              const linked = identities.find((i) => i.provider === p.id);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2 border-b border-[color:var(--color-line)] last:border-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-lg">{p.emoji}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">
                        {p.display_name}
                      </div>
                      {linked ? (
                        <div className="text-[11px] text-[color:var(--color-ink-soft)] truncate">
                          {linked.display_name}{" "}
                          {linked.email ? `· ${linked.email}` : ""}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {linked ? (
                    <form
                      action={`/api/oauth/${p.id}/unlink`}
                      method="post"
                    >
                      <button type="submit" className="btn btn-ghost btn-sm">
                        Unlink
                      </button>
                    </form>
                  ) : (
                    <a
                      href={`/api/oauth/${p.id}/start?mode=link`}
                      className="btn btn-secondary btn-sm"
                    >
                      Link
                    </a>
                  )}
                </li>
              );
            })}
            {identities
              .filter((i) => !providers.some((p) => p.id === i.provider))
              .map((i) => (
                <li
                  key={i.id}
                  className="flex items-center justify-between gap-3 py-2 border-b border-[color:var(--color-line)] last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🔗</span>
                    <div>
                      <div className="text-[13px] font-medium">
                        {i.provider}
                      </div>
                      <div className="text-[11px] text-[color:var(--color-ink-soft)]">
                        {i.display_name}{" "}
                        {i.email ? `· ${i.email}` : ""}
                      </div>
                    </div>
                  </div>
                  <form action={`/api/oauth/${i.provider}/unlink`} method="post">
                    <button type="submit" className="btn btn-ghost btn-sm">
                      Unlink
                    </button>
                  </form>
                </li>
              ))}
          </ul>
          {linkedSet.size === 0 && providers.length === 0 ? (
            <p className="text-[11px] text-[color:var(--color-ink-soft)] mt-2">
              No OAuth providers configured on this server. Operator must set
              <code className="font-mono"> A2A_OAUTH_*</code> env vars. See{" "}
              <Link href="/docs/install" className="underline">
                docs
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}

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
