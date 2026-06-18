import Link from "next/link";
import { redirect } from "next/navigation";
import { resetPassword } from "@/lib/account-email";

export const dynamic = "force-dynamic";

async function resetAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) {
    redirect(
      `/reset?token=${encodeURIComponent(token)}&error=${encodeURIComponent(
        "The two passwords don't match.",
      )}`,
    );
  }
  try {
    resetPassword(token, password);
  } catch (err) {
    redirect(
      `/reset?token=${encodeURIComponent(token)}&error=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not reset the password.",
      )}`,
    );
  }
  redirect("/sign-in?error=" + encodeURIComponent("Password updated — sign in with your new password."));
}

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link
          href="/sign-in"
          className="inline-flex items-center gap-2 text-sm font-semibold mb-10 text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
        >
          ← Back to sign in
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
        {!token ? (
          <div className="callout callout-amber mt-6 text-sm">
            <span>⚠️</span>
            <span>
              This page needs a reset link. Request one from{" "}
              <Link href="/forgot" className="underline underline-offset-4">
                Forgot your password
              </Link>
              .
            </span>
          </div>
        ) : (
          <>
            {error ? (
              <div className="callout callout-amber mt-6 text-sm">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            ) : null}
            <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
              At least 10 characters, mixing letters, numbers, and symbols.
            </p>
            <form action={resetAction} className="mt-8 space-y-4">
              <input type="hidden" name="token" value={token} />
              <label className="block">
                <span className="label">New password</span>
                <input
                  className="input"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="New password"
                />
              </label>
              <label className="block">
                <span className="label">Confirm password</span>
                <input
                  className="input"
                  name="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Repeat new password"
                />
              </label>
              <button type="submit" className="btn btn-primary btn-lg w-full">
                Update password
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
