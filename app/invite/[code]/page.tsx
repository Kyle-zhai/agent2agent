import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { getInviteByCode, redeemInvite } from "@/lib/invites";
import { listAgentsForUser, getAgent } from "@/lib/agents";
import { listConfiguredProviders } from "@/lib/oauth";

export const dynamic = "force-dynamic";

async function acceptAction(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      `/sign-in?next=${encodeURIComponent(
        `/invite/${formData.get("code")}`,
      )}`,
    );
  }
  const code = String(formData.get("code") ?? "");
  const myAgent = String(formData.get("my_agent_id") ?? "") || null;
  try {
    redeemInvite({
      code,
      redeemer_user_id: user!.id,
      redeemer_agent_id: myAgent,
    });
  } catch (err) {
    redirect(
      `/invite/${encodeURIComponent(code)}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't accept the invite.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect("/app/contacts?ok=Friend+added+via+invite");
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ error?: string; just_signed_in?: string }>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const invite = getInviteByCode(code);
  const user = await getCurrentUser();
  const providers = listConfiguredProviders();

  if (!invite) {
    return (
      <main className="max-w-md mx-auto p-8">
        <div className="callout callout-amber text-[13px]">
          This invite link doesn&apos;t exist or is no longer active.
        </div>
        <Link href="/sign-in" className="btn btn-secondary btn-sm mt-4">
          ← Back to sign in
        </Link>
      </main>
    );
  }

  const expired = invite.expires_at && invite.expires_at < Date.now();
  const exhausted = invite.used_count >= invite.max_uses;
  const inviterAgent = getAgent(invite.inviter_agent_id);

  return (
    <main className="max-w-md mx-auto p-8 space-y-4">
      <header className="text-center space-y-1">
        <div className="text-3xl">{inviterAgent?.avatar_emoji ?? "🤝"}</div>
        <h1 className="text-[20px] font-semibold">
          {inviterAgent
            ? `${inviterAgent.display_name} wants to connect`
            : "Someone invited you to Agent2Agent"}
        </h1>
        {invite.note ? (
          <p className="text-[13px] text-[color:var(--color-ink-soft)] italic">
            “{invite.note}”
          </p>
        ) : null}
      </header>

      {sp.error ? (
        <div className="callout callout-amber text-[13px]">
          ⚠ {decodeURIComponent(sp.error)}
        </div>
      ) : null}

      {expired ? (
        <div className="callout callout-amber text-[13px]">
          This invite has expired.
        </div>
      ) : exhausted ? (
        <div className="callout callout-amber text-[13px]">
          This invite has already been used up.
        </div>
      ) : !user ? (
        <section className="surface p-5 space-y-3">
          <p className="text-[13px]">
            Sign in to accept. We&apos;ll connect the two of you automatically.
          </p>
          {providers.length > 0 ? (
            <div className="grid grid-cols-1 gap-2">
              {providers.map((p) => (
                <Link
                  key={p.id}
                  href={`/api/oauth/${p.id}/start?invite=${encodeURIComponent(
                    code,
                  )}`}
                  className="btn btn-secondary btn-sm"
                >
                  {p.emoji} Continue with {p.display_name}
                </Link>
              ))}
            </div>
          ) : null}
          <Link
            href={`/sign-up?next=${encodeURIComponent(`/invite/${code}`)}`}
            className="btn btn-primary btn-sm w-full"
          >
            Create an account with email
          </Link>
          <Link
            href={`/sign-in?next=${encodeURIComponent(`/invite/${code}`)}`}
            className="text-[12px] underline block text-center"
          >
            Already have an account? Sign in →
          </Link>
        </section>
      ) : (
        <UserAcceptForm code={code} userId={user.id} />
      )}
    </main>
  );
}

async function UserAcceptForm({
  code,
  userId,
}: {
  code: string;
  userId: string;
}) {
  const agents = listAgentsForUser(userId);
  return (
    <form action={acceptAction} className="surface p-5 space-y-3">
      <input type="hidden" name="code" value={code} />
      {agents.length === 0 ? (
        <>
          <p className="text-[13px] text-[color:var(--color-ink-soft)]">
            You need an assistant before accepting an invite. Every connection
            in Agent2Agent is between two assistants — you take part through
            yours.
          </p>
          <Link
            href={`/app/agents/new?next=${encodeURIComponent(`/invite/${code}`)}`}
            className="btn btn-primary btn-sm w-full"
          >
            Create your first assistant →
          </Link>
        </>
      ) : (
        <>
          <label className="text-[12px] flex flex-col gap-1">
            <span className="text-[color:var(--color-ink-soft)]">
              Choose which of your assistants should connect with the inviter
            </span>
            <select name="my_agent_id" className="input">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.display_name} ({a.id})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm w-full">
            Accept invite & connect
          </button>
        </>
      )}
    </form>
  );
}
