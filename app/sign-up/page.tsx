import Link from "next/link";
import { redirect } from "next/navigation";
import {
  emailVerificationRequired,
  getCurrentUser,
  signUp,
  safeNextPath,
} from "@/lib/auth";
import { requestEmailVerification } from "@/lib/account-email";
import { listConfiguredProviders } from "@/lib/oauth";

export const dynamic = "force-dynamic";

async function signUpAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const name = String(formData.get("display_name") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") || "/app/welcome"));
  let userEmail: string | null = null;
  let userId: string | null = null;
  try {
    const u = await signUp(email, password, name);
    userId = u.id;
    userEmail = u.email;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sign up failed.";
    redirect(
      `/sign-up?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`,
    );
  }
  // Best-effort verification email (sendEmail never throws). Awaited so the
  // console/provider call completes before we navigate; kept OUTSIDE the
  // try above so it can't be mistaken for a signup failure.
  if (userId && userEmail) {
    await requestEmailVerification(userId, userEmail);
  }
  if (emailVerificationRequired()) {
    redirect(
      `/sign-in?error=${encodeURIComponent(
        "Check your email to verify your account before signing in.",
      )}&next=${encodeURIComponent(next)}`,
    );
  }
  redirect(next);
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const user = await getCurrentUser();
  const { error, next } = await searchParams;
  if (user) redirect(safeNextPath(next));
  const providers = listConfiguredProviders();
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
            Free during beta. You can add an assistant in two minutes.
          </p>

          {error ? (
            <div className="callout callout-amber mt-6 text-sm">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          ) : null}

          {providers.length > 0 ? (
            <>
              <div className="mt-8 space-y-2">
                {providers.map((p) => (
                  <Link
                    key={p.id}
                    href={`/api/oauth/${p.id}/start${
                      next ? `?next=${encodeURIComponent(next)}` : ""
                    }`}
                    className="btn btn-secondary w-full"
                  >
                    {p.emoji} Sign up with {p.display_name}
                  </Link>
                ))}
              </div>
              <div className="my-6 flex items-center gap-3 text-[11px] text-[color:var(--color-ink-soft)]">
                <span className="flex-1 h-px bg-[color:var(--color-line)]" />
                or use email
                <span className="flex-1 h-px bg-[color:var(--color-line)]" />
              </div>
            </>
          ) : null}

          <form action={signUpAction} className={providers.length > 0 ? "space-y-4" : "mt-8 space-y-4"}>
            <input type="hidden" name="next" value={next ?? "/app/welcome"} />
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
              minLength={10}
              placeholder="≥10 chars · 3 of: a-z, A-Z, 0-9, symbol"
              autoComplete="new-password"
            />
            <button type="submit" className="btn btn-primary btn-lg w-full">
              Create account
            </button>
          </form>

          <p className="mt-6 text-sm text-[color:var(--color-ink-muted)]">
            Already have an account?{" "}
            <Link
              href={`/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`}
              className="text-[color:var(--color-ink)] underline underline-offset-4"
            >
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
            <strong>Bob's assistant</strong> is reviewing the handoff…
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
