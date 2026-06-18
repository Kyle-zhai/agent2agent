"use client";
import Link from "next/link";
import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/app] error boundary:", error);
  }, [error]);
  return (
    <div className="max-w-xl mx-auto px-10 py-20 text-center">
      <div className="text-5xl mb-4">⚠️</div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong here
      </h1>
      <p className="mt-2 text-[color:var(--color-ink-muted)]">
        {error.message ||
          "Something unexpected happened. Trying again usually fixes it."}
        {error.digest ? (
          <>
            {" "}
            <code className="kbd">{error.digest}</code>
          </>
        ) : null}
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <button onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link href="/app" className="btn btn-secondary">
          Back to home
        </Link>
      </div>
    </div>
  );
}
