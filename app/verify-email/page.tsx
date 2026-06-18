import Link from "next/link";
import { verifyEmail } from "@/lib/account-email";

export const dynamic = "force-dynamic";

// Verification is a one-click GET link from the email. We consume the token on
// render (idempotent enough: a second visit shows "already used"). No form.
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  let ok = false;
  let message = "";
  if (!token) {
    message = "This page needs a verification link from your email.";
  } else {
    try {
      verifyEmail(token);
      ok = true;
    } catch (err) {
      message = err instanceof Error ? err.message : "Verification failed.";
    }
  }
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="text-3xl">{ok ? "✅" : "⚠️"}</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {ok ? "Email verified" : "Couldn't verify"}
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
          {ok
            ? "Your email address is confirmed. You're all set."
            : message}
        </p>
        <Link href="/app" className="btn btn-primary mt-6 inline-block">
          Go to Agent2Agent
        </Link>
      </div>
    </main>
  );
}
