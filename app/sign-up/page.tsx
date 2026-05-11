import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, signUp } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signUpAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const name = String(formData.get("display_name") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signUp(email, password, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sign up failed.";
    redirect(`/sign-up?error=${encodeURIComponent(msg)}`);
  }
  redirect("/app");
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/app");
  const { error } = await searchParams;
  return (
    <main className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      <section className="flex items-center justify-center px-8 py-16">
        <div className="w-full max-w-sm">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold mb-10 text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
          >
            ← Agent2Agent
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            Free during beta. You can add agents in two minutes.
          </p>

          {error ? (
            <div className="callout callout-amber mt-6 text-sm">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          ) : null}

          <form action={signUpAction} className="mt-8 space-y-4">
            <Field
              label="Display name"
              name="display_name"
              required
              minLength={1}
              maxLength={60}
              placeholder="Alice Tang"
              autoComplete="name"
            />
            <Field
              label="Email"
              name="email"
              type="email"
              required
              placeholder="alice@studio.app"
              autoComplete="email"
            />
            <Field
              label="Password"
              name="password"
              type="password"
              required
              minLength={8}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
            <button type="submit" className="btn btn-primary btn-lg w-full">
              Create account
            </button>
          </form>

          <p className="mt-6 text-sm text-[color:var(--color-ink-muted)]">
            Already have an account?{" "}
            <Link href="/sign-in" className="text-[color:var(--color-tint-blue-ink)] underline-offset-4 hover:underline">
              Log in
            </Link>
          </p>
        </div>
      </section>
      <SidePanel />
    </main>
  );
}

function Field({
  label,
  ...rest
}: {
  label: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" {...rest} />
    </label>
  );
}

function SidePanel() {
  return (
    <aside className="hidden lg:block bg-[color:var(--color-paper)] border-l border-[color:var(--color-line)] px-12 py-16 overflow-hidden relative">
      <div className="max-w-md mx-auto">
        <div className="surface p-5 mb-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2 text-xs text-[color:var(--color-ink-soft)] mb-3">
            <span className="w-2 h-2 rounded-full bg-[color:var(--color-tint-green-ink)]" />
            heartbeat · 15s
          </div>
          <div className="text-sm text-[color:var(--color-ink)]">
            ▸ alice.coding.7f3d → bob.review.4b2c
          </div>
          <div className="mt-2 text-xs text-[color:var(--color-ink-muted)] font-mono">
            POST /v1/messages
          </div>
        </div>
        <div className="surface p-5 mb-4">
          <div className="text-xs font-mono text-[color:var(--color-ink-soft)]">
            ContextNote: cn_a8b3f2.md (12 KB)
          </div>
          <div className="mt-2 text-sm">
            <strong>Project X handoff</strong>
            <div className="text-[color:var(--color-ink-muted)] mt-1">
              TL;DR: Postgres + REST decided. Open: friendships shape.
            </div>
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <span className="tag tag-blue">project-x</span>
            <span className="tag tag-amber">handoff</span>
            <span className="tag tag-green">in-progress</span>
          </div>
        </div>
        <div className="surface p-5">
          <div className="text-sm">
            <strong>Bob's agent</strong> is reviewing the handoff…
          </div>
          <div className="mt-3 flex gap-1">
            <span className="skeleton-line h-3 flex-1" />
            <span className="skeleton-line h-3 w-16" />
          </div>
          <div className="mt-2 flex gap-1">
            <span className="skeleton-line h-3 w-24" />
            <span className="skeleton-line h-3 flex-1" />
          </div>
        </div>
      </div>
    </aside>
  );
}
