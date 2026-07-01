import Link from "next/link";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  await requireUser();

  return (
    <div className="app-stage">
      <div className="border-b border-[color:var(--color-line)] px-4 py-1.5">
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

      <main>
        <section className="overflow-hidden bg-[color:var(--color-paper)]">
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-line)] px-4 py-2">
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

          <div className="flex items-center gap-2 border-b border-[color:var(--color-line)] px-4 py-3 text-[12px]">
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--color-tint-green-ink)]" />
            <span className="font-medium text-[color:var(--color-tint-green-ink)]">
              Workspace live
            </span>
            <span className="text-[color:var(--color-ink-soft)]">
              2 agents · 3 members · 4 launch tasks
            </span>
          </div>

          <div className="bg-white px-4 pb-4 pt-0">
            <div className="mx-auto max-w-[760px] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white shadow-[0_18px_48px_-38px_rgba(22,22,40,.45)]">
              <NovaHeader />
              <NovaHero />
              <GettingStarted />
            </div>

            <div className="mx-auto mt-4 grid max-w-[760px] grid-cols-4 overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white">
              <FooterMetric label="Tests passing" value="18 / 18" tone="green" />
              <FooterMetric label="Preview deployed" value="2m ago" tone="green" />
              <FooterMetric label="Review pending" value="1 comment" tone="amber" />
              <FooterMetric label="Grant expires in 23h" value="Write UI only" tone="amber" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function FileDocument({
  name,
  path,
  content,
}: {
  name: string;
  path: string;
  content: string;
}) {
  return (
    <div className="mx-auto max-w-[760px] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-[#101729] shadow-[0_18px_48px_-38px_rgba(22,22,40,.45)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-white">{name}</h2>
          <p className="truncate text-[11px] text-white/55">{path}</p>
        </div>
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70">
          read-only
        </span>
      </div>
      <pre className="min-h-[430px] overflow-auto p-5 text-[12.5px] leading-relaxed text-[#d8e3ff]">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function PeopleStrip() {
  const people = [
    { name: "Iris Liu", role: "You" },
    { name: "Tom Zhao", role: "" },
    { name: "Sophia Chen", role: "" },
  ];
  return (
    <div className="hidden xl:flex items-center gap-3 rounded-xl border border-[color:var(--color-line)] bg-white px-3 py-2">
      {people.map((person, index) => (
        <div key={person.name} className="flex items-center gap-2">
          <AvatarMark index={index} />
          <div className="min-w-0">
            <div className="text-[12px] font-medium leading-tight">{person.name}</div>
            {person.role ? (
              <div className="text-[10px] text-[color:var(--color-ink-soft)]">{person.role}</div>
            ) : null}
          </div>
          <span className="h-2 w-2 rounded-full bg-[color:var(--color-tint-green-ink)]" />
        </div>
      ))}
    </div>
  );
}

function AgentStrip() {
  return (
    <div className="hidden lg:flex items-center gap-3 rounded-xl border border-[color:var(--color-line)] bg-white px-3 py-2">
      <AgentChip name="Ava's Agent" role="Reviewer" />
      <AgentChip name="Milo's Agent" role="Dev Assistant" />
      <Link href="/app/contacts" className="btn btn-secondary btn-sm">
        Invite collaborator
      </Link>
      <Link href="/app/agents" className="btn btn-secondary btn-sm">
        Add my agent
      </Link>
    </div>
  );
}

function AgentChip({ name, role }: { name: string; role: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-[color:var(--color-tint-blue)] text-[color:var(--color-tint-blue-ink)]">
        <AgentIcon />
      </span>
      <div>
        <div className="text-[12px] font-medium leading-tight">{name}</div>
        <div className="text-[10px] text-[color:var(--color-ink-soft)]">{role}</div>
      </div>
      <span className="h-2 w-2 rounded-full bg-[color:var(--color-tint-green-ink)]" />
    </div>
  );
}

function NovaHeader() {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-line)] px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[color:var(--color-tint-blue-ink)] text-white">
          <LayersIcon />
        </span>
        <span className="text-[15px] font-semibold">
          Agent2Agent <span className="text-[color:var(--color-tint-blue-ink)]">Partner</span>
        </span>
      </div>
      <nav className="hidden items-center gap-7 text-[12px] text-[color:var(--color-ink-muted)] md:flex">
        <span>Workspace</span>
        <span>Tasks</span>
        <span>Agents</span>
        <span>Reviews</span>
      </nav>
      <Link href="/app/collab/new" className="btn btn-primary btn-sm">
        Open workspace
      </Link>
    </div>
  );
}

function NovaHero() {
  return (
    <section className="px-6 pb-5 pt-8 text-center">
      <span className="inline-flex rounded-full bg-[#eef4ff] px-4 py-2 text-[12px] font-medium text-[color:var(--color-tint-blue-ink)]">
        Partner onboarding workspace
      </span>
      <h2 className="mx-auto mt-5 max-w-[560px] text-[34px] font-semibold leading-[1.12] tracking-tight text-[#101729]">
        Launch Partner Access
        <br />
        With Human and Agent Review
      </h2>
      <p className="mx-auto mt-3 max-w-[520px] text-[14px] leading-relaxed text-[color:var(--color-ink-muted)]">
        A shared room where the partner team, your agent, and their agent can
        review files, approve terms, and ship the launch checklist together.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/app/collab/new" className="btn btn-primary btn-lg">
          Start review
        </Link>
        <Link href="/app/contacts" className="btn btn-secondary btn-lg">
          View contacts
        </Link>
      </div>
    </section>
  );
}

function GettingStarted() {
  const steps = [
    ["Create partner profile", "Confirm company, owner, and launch scope"],
    ["Share onboarding files", "Upload checklist, agreement, and copy deck"],
    ["Invite partner agent", "Assign review and implementation tasks"],
    ["Approve launch", "Close review after tests and preview pass"],
  ];
  return (
    <section className="mx-5 mb-4 rounded-2xl border border-[color:var(--color-line)] px-5 py-3.5">
      <h3 className="text-[14px] font-semibold">Getting started</h3>
      <div className="mt-3 grid grid-cols-4 gap-3">
        {steps.map(([title, body], index) => (
          <div key={title} className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <span
                className={
                  "grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold " +
                  (index === 0
                    ? "bg-[color:var(--color-tint-blue-ink)] text-white"
                    : "bg-[color:var(--color-line-strong)] text-white")
                }
              >
                {index + 1}
              </span>
              <span className="h-px flex-1 bg-[color:var(--color-line)]" />
            </div>
            <div className="text-[12px] font-semibold">{title}</div>
            <p className="mt-1 text-[10.5px] leading-snug text-[color:var(--color-ink-muted)]">
              {body}
            </p>
          </div>
        ))}
      </div>
      <ConsentStatus />
    </section>
  );
}

function ConsentStatus() {
  return (
    <section className="mt-4 rounded-xl border border-[color:var(--color-line)] px-4 py-2.5">
      <h3 className="text-[13px] font-semibold">Consent status</h3>
      <div className="mt-2 flex items-center gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-[color:var(--color-tint-green)] text-[color:var(--color-tint-green-ink)]">
          <CheckIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">All terms approved</div>
          <div className="truncate text-[10.5px] text-[color:var(--color-ink-muted)]">
            Partner agreement, workspace access, and launch copy are approved.
          </div>
        </div>
        <div className="hidden text-[10.5px] leading-tight text-[color:var(--color-ink-muted)] sm:block">
          Last updated
          <br />
          Jun 30, 2026 11:02 PM
        </div>
        <Link href="/app/inbox" className="btn btn-secondary btn-sm">
          View details
        </Link>
      </div>
    </section>
  );
}

function FooterMetric({ label, value, tone }: { label: string; value: string; tone: "green" | "amber" }) {
  return (
    <div className="border-r border-[color:var(--color-line)] px-4 py-3 last:border-r-0">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        <span
          className={
            "grid h-5 w-5 place-items-center rounded-full " +
            (tone === "green"
              ? "bg-[color:var(--color-tint-green)] text-[color:var(--color-tint-green-ink)]"
              : "bg-[color:var(--color-tint-amber)] text-[color:var(--color-tint-amber-ink)]")
          }
        >
          {tone === "green" ? <CheckIcon /> : <ClockIcon />}
        </span>
        {label}
      </div>
      <div className="mt-2 text-center text-[12px] text-[color:var(--color-ink-muted)]">
        {value}
      </div>
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
  icon: "code" | "eye" | "share";
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
      {icon === "code" ? <CodeIcon /> : icon === "eye" ? <EyeIcon /> : <ShareIcon />}
      <span>{label}</span>
    </Link>
  );
}

function AvatarMark({ index }: { index: number }) {
  const initials = ["IL", "TZ", "SC"][index] ?? "A";
  return (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-[color:var(--color-paper-faint)] text-[11px] font-semibold text-[color:var(--color-ink)] ring-1 ring-[color:var(--color-line)]">
      {initials}
    </span>
  );
}

function StarIcon() {
  return (
    <svg className="text-[color:var(--color-tint-amber-ink)]" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="m12 2.8 2.7 5.6 6.2.9-4.5 4.3 1.1 6.1-5.5-2.9-5.5 2.9 1.1-6.1-4.5-4.3 6.2-.9L12 2.8Z" />
    </svg>
  );
}

function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
}
function DotsIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>;
}
function CodeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m8 9-4 3 4 3" /><path d="m16 9 4 3-4 3" /></svg>;
}
function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function ShareIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="m16 6-4-4-4 4" /><path d="M12 2v13" /></svg>;
}
function ExternalIcon() {
  return <svg className="text-[color:var(--color-ink-soft)]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 17 17 7" /><path d="M9 7h8v8" /><path d="M19 13v6H5V5h6" /></svg>;
}
function AgentIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="6" y="7" width="12" height="10" rx="2" /><path d="M12 3v4" /><path d="M9 12h.01" /><path d="M15 12h.01" /></svg>;
}
function LayersIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="m4 12 8 4 8-4" /><path d="m4 17 8 4 8-4" /></svg>;
}
function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 4 4L19 6" /></svg>;
}
function ClockIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
