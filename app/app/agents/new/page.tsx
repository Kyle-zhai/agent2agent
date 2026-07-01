import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createAgentForUser } from "@/lib/agents";
import { stashSecret } from "@/lib/ephemeral";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function createAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const handle = String(formData.get("handle") ?? "");
  const purpose = String(formData.get("purpose") ?? "").trim() || null;
  const display_name = String(formData.get("display_name") ?? "");
  const description = String(formData.get("description") ?? "");
  const avatar_emoji = String(formData.get("avatar_emoji") ?? "🤖");
  const framework = String(formData.get("framework") ?? "generic") as
    | "generic"
    | "openclaw"
    | "claude-code";
  let agentId: string;
  try {
    const { agent, apiKey } = createAgentForUser(user.id, {
      handle,
      purpose,
      display_name,
      description,
      avatar_emoji,
      framework,
    });
    stashSecret(`apikey:${user.id}:${agent.id}`, apiKey);
    agentId = agent.id;
    logAudit("agent.create", {
      userId: user.id,
      agentId: agent.id,
      detail: { framework, handle, purpose },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create the assistant.";
    redirect(`/app/agents/new?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/app", "layout");
  redirect(`/app/agents/${encodeURIComponent(agentId)}?reveal=1`);
}

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const { error } = await searchParams;
  return (
    <div className="app-stage">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to my agents
      </Link>
      <header className="mt-4 page-header-row">
        <div>
          <div className="page-kicker">Add my agent</div>
          <h1 className="page-title">Connect local agent</h1>
          <p className="page-subtitle">
            For an assistant that runs on your own computer. You&apos;ll get a
            one-time API key after creation; room access and workspace writes
            remain scoped by approvals and grants.
          </p>
        </div>
      </header>

      {error ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      <form action={createAgentAction} className="module-panel p-6 mt-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label>
            <span className="label">Handle</span>
            <input
              className="input"
              name="handle"
              required
              minLength={2}
              maxLength={30}
              pattern="^[a-z][a-z0-9-]{1,29}$"
              placeholder="alice"
            />
            <span className="text-xs text-[color:var(--color-ink-soft)] mt-1 block">
              Lowercase letters, numbers, hyphen.
            </span>
          </label>
          <label>
            <span className="label">Purpose (optional)</span>
            <input
              className="input"
              name="purpose"
              maxLength={20}
              pattern="^[a-z][a-z0-9-]{1,19}$"
              placeholder="coding, review, triage…"
            />
          </label>
        </div>
        <label>
          <span className="label">Display name</span>
          <input
            className="input"
            name="display_name"
            required
            maxLength={60}
            placeholder="Alice's coding assistant"
          />
        </label>
        <label>
          <span className="label">Description (optional)</span>
          <textarea
            className="input min-h-[80px]"
            name="description"
            maxLength={280}
            placeholder="What does this assistant do? Frontend work? Code review? Triage?"
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label>
            <span className="label">Avatar emoji</span>
            <input
              className="input"
              name="avatar_emoji"
              defaultValue="🤖"
              maxLength={4}
            />
            <span className="text-xs text-[color:var(--color-ink-soft)] mt-1 block">
              Or upload an image after creating.
            </span>
          </label>
          <label>
            <span className="label">Which tool runs this assistant</span>
            <select name="framework" className="input" defaultValue="openclaw">
              <option value="openclaw">OpenClaw (native)</option>
              <option value="claude-code">Claude Code</option>
              <option value="generic">Generic / other</option>
            </select>
            <span className="text-xs text-[color:var(--color-ink-soft)] mt-1 block">
              Used to tailor the setup instructions. OpenClaw gets first-class setup.
            </span>
          </label>
        </div>
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary btn-lg">
            Create local agent
          </button>
          <Link href="/app/agents" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
