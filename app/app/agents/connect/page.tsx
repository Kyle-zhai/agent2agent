import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import {
  PERSONA_TEMPLATES,
  spawnManagedAgent,
} from "@/lib/managed-agents";
import {
  createDirectConversation,
} from "@/lib/conversations";
import { defaultBrainConfig } from "@/lib/brains";

export const dynamic = "force-dynamic";

async function connectAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const handle = String(formData.get("handle") ?? "");
  const display_name = String(formData.get("display_name") ?? "");
  const persona = String(formData.get("persona") ?? "");
  const emoji = String(formData.get("avatar_emoji") ?? "🦀");
  const templateKey = String(formData.get("template_key") ?? "blank");
  const startChatRaw = String(formData.get("start_chat_with") ?? "");
  let agentId: string;
  try {
    const agent = spawnManagedAgent(user.id, {
      handle,
      purpose: "agent",
      display_name,
      persona,
      avatar_emoji: emoji,
      framework: "openclaw",
      description: `OpenClaw managed agent (${templateKey})`,
    });
    agentId = agent.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not connect.";
    redirect(`/app/agents/connect?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/app", "layout");

  // Optional: open a chat with one of your existing agents right away.
  if (startChatRaw) {
    try {
      const conv = createDirectConversation(user.id, startChatRaw, agentId);
      redirect(`/app/c/${conv.id}`);
    } catch {
      // fall through to detail
    }
  }
  redirect(`/app/agents/${encodeURIComponent(agentId)}?ok=Agent+connected`);
}

export default async function ConnectAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; template?: string }>;
}) {
  const user = await requireUser();
  const { error, template } = await searchParams;
  const myAgents = listAgentsForUser(user.id);
  const cfg = defaultBrainConfig();
  const tpl =
    PERSONA_TEMPLATES.find((t) => t.key === template) ??
    PERSONA_TEMPLATES[0];

  return (
    <div className="max-w-3xl mx-auto px-10 py-12">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to agents
      </Link>
      <div className="mt-4 flex items-baseline gap-3 flex-wrap">
        <h1 className="text-3xl font-semibold tracking-tight">
          Connect a managed agent
        </h1>
        <span className="tag tag-violet">like adding a Telegram bot</span>
      </div>
      <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
        Spins up a hosted OpenClaw-style persona inside Agent2Agent. No local
        install needed — chat with it directly. Auto-friended with your other
        agents so you can pull it into groups instantly.
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-ink-soft)]">
        Brain: <code className="kbd">{cfg.provider}</code>
        {cfg.model ? <> · model <code className="kbd">{cfg.model}</code></> : null}
        {cfg.provider === "mock" ? (
          <> · set <code className="kbd">ANTHROPIC_API_KEY</code> for live LLM responses</>
        ) : null}
      </p>

      {error ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      <section className="mt-8">
        <h2 className="font-medium mb-3">Pick a persona template</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PERSONA_TEMPLATES.map((t) => (
            <Link
              key={t.key}
              href={`/app/agents/connect?template=${encodeURIComponent(t.key)}`}
              className={`surface p-4 surface-hover block ${
                t.key === tpl.key
                  ? "border-[color:var(--color-tint-violet-ink)] bg-[color:var(--color-tint-violet)]/30"
                  : ""
              }`}
            >
              <div className="text-2xl mb-1">{t.emoji}</div>
              <div className="font-medium text-sm">{t.display_name}</div>
              <div className="text-xs text-[color:var(--color-ink-muted)] mt-1">
                {t.description}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <form action={connectAction} className="mt-8 surface p-5 space-y-4">
        <input type="hidden" name="template_key" value={tpl.key} />
        <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr_1fr] gap-3">
          <label>
            <span className="label">Emoji</span>
            <input
              className="input"
              name="avatar_emoji"
              defaultValue={tpl.emoji}
              maxLength={4}
            />
          </label>
          <label>
            <span className="label">Display name</span>
            <input
              className="input"
              name="display_name"
              required
              maxLength={60}
              defaultValue={tpl.display_name}
            />
          </label>
          <label>
            <span className="label">Handle</span>
            <input
              className="input"
              name="handle"
              required
              minLength={2}
              maxLength={30}
              pattern="^[a-z][a-z0-9-]{1,29}$"
              defaultValue={tpl.key.replace(/-/g, "")}
            />
            <span className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 block">
              Becomes part of the agent ID.
            </span>
          </label>
        </div>
        <label>
          <span className="label">Persona / system prompt</span>
          <textarea
            name="persona"
            className="input min-h-[140px] font-mono text-[12.5px]"
            defaultValue={tpl.persona}
            placeholder="What this agent is, how it should behave, what it should optimize for…"
          />
        </label>
        {myAgents.length > 0 ? (
          <label>
            <span className="label">Open a chat right after creating</span>
            <select name="start_chat_with" className="input" defaultValue="">
              <option value="">(no — just create it)</option>
              {myAgents
                .filter((a) => a.agent_kind === "external")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    chat as {a.avatar_emoji} {a.id}
                  </option>
                ))}
            </select>
            <span className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 block">
              We'll auto-friend the new managed agent with all your existing agents either way.
            </span>
          </label>
        ) : null}
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary btn-lg">
            Connect agent
          </button>
          <Link href="/app/agents" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
