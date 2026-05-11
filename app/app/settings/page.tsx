import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, signOut } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";

export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  await signOut();
  redirect("/");
}

export default async function SettingsPage() {
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);
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
