import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { WorkspaceFilePreview } from "@/components/WorkspaceFilePreview";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  await requireUser();

  return (
    <div className="app-stage flex h-full flex-col">
      <div className="shrink-0 border-b border-[color:var(--color-line)] px-4 py-1.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 min-w-[150px] items-center justify-between gap-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 text-[12px] font-medium">
            <span>Partner onboarding</span>
            <span className="h-2 w-2 rounded-full bg-[color:var(--color-tint-green-ink)]" />
          </div>
          <Link
            href="/app/collab/new"
            className="grid h-8 w-8 place-items-center rounded-lg text-[color:var(--color-ink-soft)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]"
            aria-label="New tab"
          >
            <PlusIcon />
          </Link>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--color-line)] px-4 py-2">
        <div className="min-w-0 truncate text-[12px] text-[color:var(--color-ink-soft)]">
          Partner onboarding <span className="mx-1">/</span> Agent workspace
        </div>
        <div className="flex items-center gap-2">
          <PreviewButton active href="/app" label="Overview" icon="eye" />
          <PreviewButton href="/app/contacts" label="Share" icon="share" />
          <Link
            href="/app/settings"
            className="grid h-8 w-8 place-items-center rounded-lg border border-[color:var(--color-line)] text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)]"
            aria-label="More"
          >
            <DotsIcon />
          </Link>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--color-line)] px-4 py-2.5 text-[12px]">
        <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--color-tint-green-ink)]" />
        <span className="font-medium text-[color:var(--color-tint-green-ink)]">Workspace live</span>
        <span className="text-[color:var(--color-ink-soft)]">2 agents · 3 members · 4 launch tasks</span>
      </div>

      <main className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceFilePreview />
      </main>
    </div>
  );
}

function PreviewButton({
  href,
  label,
  icon,
  active = false,
}: {
  href: string;
  label: string;
  icon: "eye" | "share";
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        "btn btn-sm " +
        (active
          ? "border-[#bfd3ff] bg-[#eef4ff] text-[color:var(--color-tint-blue-ink)]"
          : "btn-secondary")
      }
    >
      {icon === "eye" ? <EyeIcon /> : <ShareIcon />}
      <span>{label}</span>
    </Link>
  );
}

function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
}
function DotsIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>;
}
function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function ShareIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="m16 6-4-4-4 4" /><path d="M12 2v13" /></svg>;
}
