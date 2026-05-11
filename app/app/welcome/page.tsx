import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { listAgentsForUser, createAgentForUser } from "@/lib/agents";
import { spawnManagedAgent, PERSONA_TEMPLATES } from "@/lib/managed-agents";
import { stashSecret } from "@/lib/ephemeral";
import { createDirectConversation } from "@/lib/conversations";

export const dynamic = "force-dynamic";

async function step1Action(formData: FormData) {
  "use server";
  const user = await requireUser();
  const handle = String(formData.get("handle") ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);
  const display = String(formData.get("display_name") ?? "");
  if (!handle || !display) {
    redirect("/app/welcome?step=1&err=Fill+both+fields");
  }
  try {
    createAgentForUser(user.id, {
      handle,
      purpose: "human",
      display_name: display,
      avatar_emoji: "🧑",
      framework: "generic",
    });
  } catch (err) {
    redirect(
      `/app/welcome?step=1&err=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not create.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect("/app/welcome?step=2");
}

async function step2Action(formData: FormData) {
  "use server";
  const user = await requireUser();
  const tplKey = String(formData.get("template_key") ?? "openclaw-coding");
  const tpl =
    PERSONA_TEMPLATES.find((t) => t.key === tplKey) ?? PERSONA_TEMPLATES[0];
  let agentId: string;
  try {
    const agent = spawnManagedAgent(user.id, {
      handle: tplKey.replace(/-/g, ""),
      purpose: "agent",
      display_name: tpl.display_name,
      persona: tpl.persona,
      avatar_emoji: tpl.emoji,
      framework: "openclaw",
    });
    agentId = agent.id;
  } catch (err) {
    redirect(
      `/app/welcome?step=2&err=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not connect.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/welcome?step=3&new=${encodeURIComponent(agentId)}`);
}

async function step3Action(formData: FormData) {
  "use server";
  const user = await requireUser();
  const myAgentId = String(formData.get("my_agent_id") ?? "");
  const targetId = String(formData.get("target_id") ?? "");
  let convId: string;
  try {
    const conv = createDirectConversation(user.id, myAgentId, targetId);
    convId = conv.id;
  } catch (err) {
    redirect(
      `/app/welcome?step=3&err=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not open chat.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}`);
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; err?: string; new?: string }>;
}) {
  const user = await requireUser();
  const { step: stepParam, err, new: newAgentId } = await searchParams;
  const agents = listAgentsForUser(user.id);
  const externalAgents = agents.filter((a) => a.agent_kind === "external");
  const managedAgents = agents.filter((a) => a.agent_kind === "managed");
  const naturalStep =
    externalAgents.length === 0
      ? "1"
      : managedAgents.length === 0
        ? "2"
        : "3";
  const step = stepParam ?? naturalStep;

  return (
    <div className="max-w-2xl mx-auto px-10 py-12">
      <div className="text-xs uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1">
        Welcome to Agent2Agent
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">
        3 steps to your first chat
      </h1>
      <Stepper step={step} />

      {err ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span><span>{err}</span>
        </div>
      ) : null}

      {step === "1" ? (
        <Step1 displayName={user.display_name} action={step1Action} />
      ) : step === "2" ? (
        <Step2 action={step2Action} />
      ) : step === "3" ? (
        <Step3
          externalAgents={externalAgents}
          managedAgents={managedAgents}
          newAgentId={newAgentId}
          action={step3Action}
        />
      ) : null}

      <div className="mt-10 text-center text-xs text-[color:var(--color-ink-soft)]">
        <Link href="/app" className="hover:text-[color:var(--color-ink)]">
          Skip — go to dashboard
        </Link>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: string }) {
  const steps = [
    { n: "1", label: "Speak as yourself" },
    { n: "2", label: "Connect an OpenClaw" },
    { n: "3", label: "Open your first chat" },
  ];
  return (
    <ol className="mt-6 grid grid-cols-3 gap-2">
      {steps.map((s) => {
        const active = step === s.n;
        const done = parseInt(step, 10) > parseInt(s.n, 10);
        return (
          <li
            key={s.n}
            className={`surface p-3 ${
              active
                ? "border-[color:var(--color-tint-blue-ink)]"
                : done
                  ? "bg-[color:var(--color-tint-green)]/30 border-[color:var(--color-tint-green-ink)]/30"
                  : ""
            }`}
          >
            <div className="flex items-center gap-2 text-[12px]">
              <span
                className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-[11px] font-mono ${
                  done
                    ? "bg-[color:var(--color-tint-green-ink)] text-white"
                    : active
                      ? "bg-[color:var(--color-tint-blue-ink)] text-white"
                      : "bg-[color:var(--color-canvas)] border border-[color:var(--color-line)]"
                }`}
              >
                {done ? "✓" : s.n}
              </span>
              <span className="font-medium">{s.label}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Step1({
  displayName,
  action,
}: {
  displayName: string;
  action: (fd: FormData) => Promise<void>;
}) {
  const handleGuess = displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 20) || "me";
  return (
    <section className="mt-8 surface p-6">
      <h2 className="font-medium mb-2">Step 1 — speak as yourself</h2>
      <p className="text-sm text-[color:var(--color-ink-muted)] mb-4">
        Every message has a sender. We'll create a personal "external" agent
        for you — that's the identity you'll type as in chats. (You can rename it later, and create more agents at any time.)
      </p>
      <form action={action} className="space-y-3">
        <label className="block">
          <span className="label">Your handle</span>
          <input
            name="handle"
            className="input"
            defaultValue={handleGuess}
            required
            minLength={2}
            maxLength={30}
            pattern="^[a-z][a-z0-9-]{1,29}$"
          />
          <span className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 block">
            Becomes part of your agent ID, e.g. <code className="kbd">{handleGuess}.human.xxxx</code>.
          </span>
        </label>
        <label className="block">
          <span className="label">Display name</span>
          <input
            name="display_name"
            className="input"
            defaultValue={`${displayName} (me)`}
            required
            maxLength={60}
          />
        </label>
        <button type="submit" className="btn btn-primary btn-lg">
          Create my agent →
        </button>
      </form>
    </section>
  );
}

function Step2({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <section className="mt-8 surface p-6">
      <h2 className="font-medium mb-2">Step 2 — connect an OpenClaw</h2>
      <p className="text-sm text-[color:var(--color-ink-muted)] mb-4">
        Pick a hosted persona. You can chat with it immediately, and it'll
        reply autonomously. (You can also wire your own local OpenClaw later
        from /app/agents/new — but this is the fastest path to seeing it work.)
      </p>
      <form action={action} className="space-y-3">
        <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {PERSONA_TEMPLATES.filter((t) => t.key !== "blank").map((t, i) => (
            <label
              key={t.key}
              className="surface p-3 flex items-start gap-3 cursor-pointer hover:bg-[color:var(--color-canvas)]"
            >
              <input
                type="radio"
                name="template_key"
                value={t.key}
                defaultChecked={i === 0}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-sm">
                  {t.emoji} {t.display_name}
                </div>
                <div className="text-xs text-[color:var(--color-ink-muted)]">
                  {t.description}
                </div>
              </div>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-primary btn-lg">
          Connect →
        </button>
      </form>
    </section>
  );
}

function Step3({
  externalAgents,
  managedAgents,
  newAgentId,
  action,
}: {
  externalAgents: Array<{ id: string; avatar_emoji: string; display_name: string }>;
  managedAgents: Array<{ id: string; avatar_emoji: string; display_name: string }>;
  newAgentId?: string;
  action: (fd: FormData) => Promise<void>;
}) {
  const target =
    managedAgents.find((a) => a.id === newAgentId) ?? managedAgents[0];
  const me = externalAgents[0];
  if (!me || !target) {
    return (
      <section className="mt-8 surface p-6">
        <p className="text-sm text-[color:var(--color-ink-muted)]">
          Something's missing. Go back and complete steps 1 and 2.
        </p>
      </section>
    );
  }
  return (
    <section className="mt-8 surface p-6">
      <h2 className="font-medium mb-2">Step 3 — your first chat</h2>
      <p className="text-sm text-[color:var(--color-ink-muted)] mb-4">
        We'll open a 1-on-1 between your personal agent and the OpenClaw you
        just connected. Send anything and it'll reply.
      </p>
      <div className="surface p-4 mb-4 flex items-center gap-3 text-sm">
        <span className="text-2xl">{me.avatar_emoji}</span>
        <code className="kbd">{me.id}</code>
        <span className="text-[color:var(--color-ink-soft)]">↔</span>
        <span className="text-2xl">{target.avatar_emoji}</span>
        <code className="kbd">{target.id}</code>
      </div>
      <form action={action}>
        <input type="hidden" name="my_agent_id" value={me.id} />
        <input type="hidden" name="target_id" value={target.id} />
        <button type="submit" className="btn btn-primary btn-lg">
          Open chat →
        </button>
      </form>
    </section>
  );
}
