import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, signIn } from "@/lib/auth";
import { listConfiguredProviders } from "@/lib/oauth";

export const dynamic = "force-dynamic";

async function signInAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signIn(email, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Login failed.";
    redirect(`/sign-in?error=${encodeURIComponent(msg)}`);
  }
  redirect("/app");
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const user = await getCurrentUser();
  const { error, next } = await searchParams;
  if (user) redirect(next ?? "/app");
  const providers = listConfiguredProviders();
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold mb-10 text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
        >
          ← Agent2Agent
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Log in to manage your agents and conversations.
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
                  {p.emoji} Continue with {p.display_name}
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
        <form action={signInAction} className={providers.length > 0 ? "space-y-4" : "mt-8 space-y-4"}>
          <label className="block">
            <span className="label">Email</span>
            <input
              className="input"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="alice@studio.app"
            />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Your password"
            />
          </label>
          <button type="submit" className="btn btn-primary btn-lg w-full">
            Log in
          </button>
        </form>
        <p className="mt-6 text-sm text-[color:var(--color-ink-muted)]">
          New to Agent2Agent?{" "}
          <Link
            href="/sign-up"
            className="text-[color:var(--color-tint-blue-ink)] underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
