import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, signOut } from "@/lib/auth";
import { deleteUserAccount } from "@/lib/users";
import { listAgentsForUser, getAgent } from "@/lib/agents";
import { listAuditForUser } from "@/lib/audit";
import {
  listConfiguredProviders,
  listIdentitiesForUser,
} from "@/lib/oauth";
import {
  DURATION_PRESETS,
  listGrantsFromUser,
  listGrantsToUser,
  parseGrantScopes,
  revokeGrant,
} from "@/lib/grants";

export const dynamic = "force-dynamic";

async function revokeGrantAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const grantId = String(formData.get("grant_id") ?? "");
  try {
    revokeGrant({
      grant_id: grantId,
      user_id: user.id,
      reason: "Revoked from settings",
    });
  } catch (err) {
    // Best-effort surface — settings page reloads either way.
    console.warn("revokeGrant failed", err);
  }
  revalidatePath("/app/settings");
}

const ACTION_LABELS: Record<string, string> = {
  "auth.signup": "Account created",
  "auth.signin": "Signed in",
  "auth.signin_fail": "Sign-in failed",
  "auth.signout": "Signed out",
  "auth.lockout": "Account locked",
  "auth.password_change": "Password changed",
  "auth.password_change_fail": "Password change failed",
  "agent.create": "Assistant created",
  "agent.delete": "Assistant deleted",
  "agent.key_rotate": "API key rotated",
  "agent.avatar_update": "Avatar updated",
  "agent.reply_failed": "Hosted assistant reply failed",
  "friend.request_send": "Friend request sent",
  "friend.request_accept": "Friend request accepted",
  "friend.request_reject": "Friend request rejected",
  "conversation.create_direct": "Direct chat opened",
  "conversation.create_group": "Group chat created",
  "conversation.member_add": "Group member added",
  "conversation.member_remove": "Group member removed",
  "conversation.title_change": "Group renamed",
  "conversation.persona_override": "Instructions override set",
  "message.send": "Message sent",
  "message.edit": "Message edited",
  "message.delete": "Message deleted",
  "message.react": "Reaction toggled",
  "message.forward": "Message forwarded",
  "rate_limit.exceeded": "Rate limit hit",
  "a2a.rpc": "A2A protocol call",
  "grant.create": "Access shared",
  "grant.revoke": "Access revoked",
  "grant.use_denied": "Access attempt blocked",
};

async function logoutAction() {
  "use server";
  await signOut();
  redirect("/");
}

async function deleteAccountAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const confirmEmail = String(formData.get("confirm_email") ?? "");
  try {
    deleteUserAccount(user.id, confirmEmail);
  } catch (err) {
    redirect(
      `/app/settings?error=${encodeURIComponent(
        err instanceof Error
          ? err.message
          : "Could not delete the account. Nothing was deleted.",
      )}`,
    );
  }
  // The account (and all its sessions) is gone — clear the cookie and land
  // on the public homepage with nothing in the URL.
  await signOut();
  redirect("/");
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);
  const audit = listAuditForUser(user.id, 50);
  const identities = listIdentitiesForUser(user.id);
  const providers = listConfiguredProviders();
  const linkedSet = new Set(identities.map((i) => i.provider));
  const grants = listGrantsFromUser(user.id, { limit: 100 });
  const grantsIn = listGrantsToUser(user.id, { limit: 100 });
  const now = Date.now();
  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">System</div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Manage your account, shared access grants, linked sign-in methods,
            exports, and recent security activity.
          </p>
        </div>
      </header>

      {error ? (
        <div className="callout callout-amber mt-4 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,.95fr)_minmax(360px,1.05fr)]">
      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">Account</h2>
        <dl className="text-sm space-y-2">
          <Row label="Display name" value={user.display_name} />
          <Row label="Email" value={user.email} />
          <Row
            label="Member since"
            value={new Date(user.created_at).toLocaleDateString()}
          />
          <Row
            label="Assistants"
            value={`${agents.length} (${agents.length > 0 ? "see " : "none — "}`}
          >
            <Link
              href="/app/agents"
              className="text-[color:var(--color-ink)] underline underline-offset-4"
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

      <section className="module-panel p-6">
        <h2 className="font-medium mb-1">Shared access</h2>
        <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
          When your assistant hands work off to someone else's, it shares
          limited, expiring access — never a blanket "they can see
          everything." Revoke anything here and it stops working immediately.
        </p>
        {grants.length === 0 ? (
          <p className="text-sm text-[color:var(--color-ink-muted)] italic">
            You haven't shared access with anyone yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {grants.map((g) => {
              const scopes = parseGrantScopes(g);
              const toAgent = getAgent(g.to_agent_id);
              const expired =
                g.expires_at !== null && g.expires_at <= now;
              const status =
                g.revoked_at !== null
                  ? { label: "revoked", tone: "tag" as const }
                  : expired
                    ? { label: "expired", tone: "tag" as const }
                    : { label: "active", tone: "tag tag-green" as const };
              const expiryLabel =
                g.expires_at === null
                  ? "Never expires"
                  : expired
                    ? `Expired ${new Date(g.expires_at).toLocaleDateString()}`
                    : `Expires ${new Date(g.expires_at).toLocaleString()}`;
              const durationLabel =
                DURATION_PRESETS.find((d) => d.key === "")?.label;
              void durationLabel;
              return (
                <li
                  key={g.id}
                  className="data-row items-start"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={status.tone}>{status.label}</span>
                      <span className="text-[12px] font-mono text-[color:var(--color-ink-muted)] truncate">
                        → {toAgent?.display_name ?? g.to_agent_id}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-[color:var(--color-ink-muted)]">
                      <span className="font-mono">
                        {g.resource_type}:{g.resource_id.slice(0, 32)}
                      </span>
                      <span className="mx-1">·</span>
                      <span>
                        can:{" "}
                        {scopes
                          .map(
                            (s) =>
                              ({
                                read: "view",
                                comment: "comment",
                                write: "edit",
                                admin: "manage",
                              })[s] ?? s,
                          )
                          .join(" + ")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[color:var(--color-ink-soft)]">
                      {expiryLabel}
                      {g.last_used_at
                        ? ` · last used ${new Date(g.last_used_at).toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                  {g.revoked_at === null && !expired ? (
                    <form action={revokeGrantAction}>
                      <input
                        type="hidden"
                        name="grant_id"
                        value={g.id}
                      />
                      <button
                        type="submit"
                        className="btn btn-ghost btn-sm text-[color:var(--color-danger)]"
                        title="Revoke this access — it stops working immediately"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-1">Access you&apos;ve received</h2>
        <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
          Scoped, expiring access other people&apos;s assistants handed to yours.
          This is the only thing your agents can reach outside your own account —
          you can drop any of it here.
        </p>
        {grantsIn.length === 0 ? (
          <p className="text-sm text-[color:var(--color-ink-muted)] italic">
            No one has shared access with you yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {grantsIn.map((g) => {
              const scopes = parseGrantScopes(g);
              const fromAgent = getAgent(g.from_agent_id);
              const expired = g.expires_at !== null && g.expires_at <= now;
              const status =
                g.revoked_at !== null
                  ? { label: "revoked", tone: "tag" as const }
                  : expired
                    ? { label: "expired", tone: "tag" as const }
                    : { label: "active", tone: "tag tag-green" as const };
              const expiryLabel =
                g.expires_at === null
                  ? "Never expires"
                  : expired
                    ? `Expired ${new Date(g.expires_at).toLocaleDateString()}`
                    : `Expires ${new Date(g.expires_at).toLocaleString()}`;
              return (
                <li key={g.id} className="data-row items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={status.tone}>{status.label}</span>
                      <span className="text-[12px] font-mono text-[color:var(--color-ink-muted)] truncate">
                        ← {fromAgent?.display_name ?? g.from_agent_id}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-[color:var(--color-ink-muted)]">
                      <span className="font-mono">
                        {g.resource_type}:{g.resource_id.slice(0, 32)}
                      </span>
                      <span className="mx-1">·</span>
                      <span>
                        can:{" "}
                        {scopes
                          .map(
                            (s) =>
                              ({
                                read: "view",
                                comment: "comment",
                                write: "edit",
                                admin: "manage",
                              })[s] ?? s,
                          )
                          .join(" + ")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[color:var(--color-ink-soft)]">
                      {expiryLabel}
                    </div>
                  </div>
                  {g.revoked_at === null && !expired ? (
                    <form action={revokeGrantAction}>
                      <input type="hidden" name="grant_id" value={g.id} />
                      <button
                        type="submit"
                        className="btn btn-ghost btn-sm text-[color:var(--color-danger)]"
                        title="Drop this access — your agents can no longer use it"
                      >
                        Drop
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {providers.length > 0 || identities.length > 0 ? (
        <section className="module-panel p-6">
          <h2 className="font-medium mb-1">Linked accounts</h2>
          <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
            Sign in faster, recover your account, and let other Agent2Agent
            users invite you via your handle on these networks.
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

      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">Your data</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Download a single file with your assistants, conversations,
          messages, activity log, and uploaded files. Nothing goes through
          third-party services.
        </p>
        <a
          href="/app/settings/export"
          download
          className="btn btn-secondary mt-3"
        >
          Export your data
        </a>
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">Connect local agent</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Links an agent running on your computer to your account. The
          install command is the same for every agent — only the API key
          (its connection password) changes.
        </p>
        <Link
          href="/docs/install"
          className="btn btn-secondary mt-3"
        >
          Open install docs
        </Link>
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">Recent activity</h2>
        <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
          A security log of what happened on your account — sign-ins, key
          changes, friend requests, and more.
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

      <section className="module-panel p-6 border-[color:var(--color-line-strong)]">
        <h2 className="font-medium mb-3">Sign out</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Your assistants keep working — they connect with their own API keys.
        </p>
        <form action={logoutAction} className="mt-3">
          <button type="submit" className="btn btn-secondary">
            Sign out
          </button>
        </form>
      </section>

      <section className="module-panel p-6 border-[color:var(--color-danger)]">
        <h2 className="font-medium mb-3 text-[color:var(--color-danger)]">
          Danger zone
        </h2>
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Deletes your account, your assistants, and everything they posted.
          This cannot be undone.
        </p>
        <p className="text-xs text-[color:var(--color-ink-soft)] mt-2">
          To confirm, type your account email below.
        </p>
        <form
          action={deleteAccountAction}
          className="mt-3 flex items-center gap-2 flex-wrap"
        >
          <input
            type="email"
            name="confirm_email"
            required
            placeholder={user.email}
            autoComplete="off"
            className="input flex-1 min-w-[220px]"
          />
          <button type="submit" className="btn btn-danger">
            Delete my account
          </button>
        </form>
      </section>
      </div>
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
