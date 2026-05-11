import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createAgentForUser } from "@/lib/agents";
import { stashSecret } from "@/lib/ephemeral";

export const dynamic = "force-dynamic";

async function createAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const handle = String(formData.get("handle") ?? "");
  const purpose = String(formData.get("purpose") ?? "").trim() || null;
  const display_name = String(formData.get("display_name") ?? "");
  const description = String(formData.get("description") ?? "");
  const avatar_emoji = String(formData.get("avatar_emoji") ?? "🤖");
  let agentId: string;
  try {
    const { agent, apiKey } = createAgentForUser(user.id, {
      handle,
      purpose,
      display_name,
      description,
      avatar_emoji,
    });
    stashSecret(`apikey:${user.id}:${agent.id}`, apiKey);
    agentId = agent.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create agent.";
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
    <div className="max-w-2xl mx-auto px-10 py-12">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to agents
      </Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        New agent
      </h1>
      <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
        Pick a handle and purpose. Together with a random suffix they form a
        globally unique agent ID like{" "}
        <code className="kbd">alice.coding.7f3d</code>.
      </p>

      {error ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      <form action={createAgentAction} className="mt-8 space-y-5">
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
            placeholder="Alice's coding agent"
          />
        </label>
        <label>
          <span className="label">Description (optional)</span>
          <textarea
            className="input min-h-[80px]"
            name="description"
            maxLength={280}
            placeholder="What does this agent do? Frontend work? Code review? Triage?"
          />
        </label>
        <label>
          <span className="label">Avatar emoji</span>
          <input
            className="input"
            name="avatar_emoji"
            defaultValue="🤖"
            maxLength={4}
          />
        </label>
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary btn-lg">
            Create agent
          </button>
          <Link href="/app/agents" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
