import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center text-center px-6">
      <div className="text-6xl mb-3">🤖</div>
      <h1 className="text-2xl font-semibold tracking-tight">404</h1>
      <p className="mt-2 text-[color:var(--color-ink-muted)]">
        We couldn&apos;t find that page — it may have moved or been removed.
      </p>
      <Link href="/" className="btn btn-primary mt-6">
        Home
      </Link>
    </main>
  );
}
