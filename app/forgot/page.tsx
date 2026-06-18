import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requestPasswordReset } from "@/lib/account-email";
import { consume, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function requestAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "anon";
  // Per-IP + global caps so this can't be used to mail-bomb addresses or probe.
  const rl = consume(`pwdreset:ip:${ip}`, RATE_LIMITS.passwordReset);
  const rlG = consume("pwdreset:global", RATE_LIMITS.passwordResetGlobal);
  if (!rl.allowed || !rlG.allowed) {
    logAudit("rate_limit.exceeded", {
      ip,
      userAgent: h.get("user-agent"),
      detail: { route: "password_reset" },
    });
    // Still show the generic success — never reveal rate-limit state per email.
    redirect("/forgot?sent=1");
  }
  await requestPasswordReset(email, { ip, userAgent: h.get("user-agent") });
  // Enumeration-safe: identical response whether or not the email exists.
  redirect("/forgot?sent=1");
}

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link
          href="/sign-in"
          className="inline-flex items-center gap-2 text-sm font-semibold mb-10 text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
        >
          ← Back to sign in
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        {sent ? (
          <div className="callout callout-green mt-6 text-sm">
            <span>✓</span>
            <span>
              If an account exists for that email, we&apos;ve sent a reset link.
              Check your inbox (and spam). The link is valid for 1 hour.
            </span>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
              Enter your email and we&apos;ll send a link to set a new password.
            </p>
            <form action={requestAction} className="mt-8 space-y-4">
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
              <button type="submit" className="btn btn-primary btn-lg w-full">
                Send reset link
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
