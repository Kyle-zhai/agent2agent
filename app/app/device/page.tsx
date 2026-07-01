import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { consume, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import {
  approveDeviceAuth,
  denyDeviceAuth,
  getPendingByUserCode,
  normalizeUserCode,
} from "@/lib/device-auth";

export const dynamic = "force-dynamic";

// Human side of the device-authorization flow: the local agent shows its
// user a code; the user types it here, reviews WHAT is asking, and approves
// — minting a new external agent whose API key the device claims on its
// next poll. No key ever passes through a clipboard.

// Throttle on everything that resolves a user_code (lookup, approve, deny)
// — same dual-layer pattern as lib/auth.ts signin. Without it a signed-in
// attacker could enumerate live codes and bind a victim's device to their
// own account. Per-IP bucket for the polite case + a constant-key global
// bucket so rotating IPs (or spoofing x-forwarded-for) doesn't help.
// Returns retry seconds when over budget, null when fine.
async function consumeDeviceLookup(): Promise<number | null> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "anon";
  const rl = consume(`device.lookup:ip:${ip}`, RATE_LIMITS.deviceLookup);
  if (!rl.allowed) {
    logAudit("rate_limit.exceeded", {
      ip,
      userAgent: h.get("user-agent"),
      detail: { route: "device.lookup", scope: "ip" },
    });
    return rl.retryAfterSeconds;
  }
  const global = consume("device.lookup:global", RATE_LIMITS.deviceLookupGlobal);
  if (!global.allowed) {
    logAudit("rate_limit.exceeded", {
      ip,
      userAgent: h.get("user-agent"),
      detail: { route: "device.lookup", scope: "global" },
    });
    return global.retryAfterSeconds;
  }
  return null;
}

async function approveAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const code = String(formData.get("user_code") ?? "");
  const handle = String(formData.get("handle") ?? "");
  const display_name = String(formData.get("display_name") ?? "");
  const retry = await consumeDeviceLookup();
  if (retry !== null) {
    redirect(
      `/app/device?error=${encodeURIComponent(
        `Too many code lookups. Try again in ${retry}s.`,
      )}`,
    );
  }
  let agentId: string;
  try {
    const { agent } = approveDeviceAuth(user.id, code, { handle, display_name });
    agentId = agent.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not approve.";
    redirect(
      `/app/device?code=${encodeURIComponent(code)}&error=${encodeURIComponent(msg)}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/device?approved=${encodeURIComponent(agentId)}`);
}

async function denyAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const code = String(formData.get("user_code") ?? "");
  const retry = await consumeDeviceLookup();
  if (retry !== null) {
    redirect(
      `/app/device?error=${encodeURIComponent(
        `Too many code lookups. Try again in ${retry}s.`,
      )}`,
    );
  }
  try {
    denyDeviceAuth(user.id, code);
  } catch {
    // already gone — fall through to the denied notice either way
  }
  redirect("/app/device?denied=1");
}

function suggestHandle(agentName: string): string {
  const h = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return /^[a-z][a-z0-9-]{1,29}$/.test(h) ? h : "my-agent";
}

export default async function DeviceAuthPage({
  searchParams,
}: {
  searchParams: Promise<{
    code?: string;
    error?: string;
    approved?: string;
    denied?: string;
  }>;
}) {
  await requireUser();
  const { code, error, approved, denied } = await searchParams;
  const normalized = code ? normalizeUserCode(code) : "";
  // The "Look up" form is a GET — this render IS the lookup, so the per-IP
  // budget applies here too, before the code ever reaches the database.
  let rateError: string | null = null;
  let pending = null;
  if (normalized) {
    const retry = await consumeDeviceLookup();
    if (retry !== null) {
      rateError = `Too many code lookups. Try again in ${retry}s.`;
    } else {
      pending = getPendingByUserCode(normalized);
    }
  }
  const shownError = error ?? rateError;
  const approvedAgent = approved ? getAgent(approved) : null;

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
          <div className="page-kicker">Device approval</div>
          <h1 className="page-title">Connect a device</h1>
          <p className="page-subtitle">
            A local agent on your computer showed you a code. Enter it below to
            link that agent to your account — no key copy-pasting.
          </p>
        </div>
      </header>

      {shownError ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{shownError}</span>
        </div>
      ) : null}

      {approvedAgent ? (
        <div className="module-panel p-5 mt-8 max-w-2xl">
          <div className="tag tag-green">connected</div>
          <h2 className="font-medium mt-2">Device connected</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            <code className="kbd">{approvedAgent.id}</code> is connected. Go
            back to your terminal — the assistant picks up its connection
            details automatically (within about 5 seconds).
          </p>
          <Link
            href={`/app/agents/${encodeURIComponent(approvedAgent.id)}`}
            className="btn btn-secondary mt-4 inline-block"
          >
            View assistant
          </Link>
        </div>
      ) : denied ? (
        <div className="module-panel p-5 mt-8 max-w-2xl">
          <div className="tag">denied</div>
          <h2 className="font-medium mt-2">Request denied</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            The device was told no. Nothing was created.
          </p>
        </div>
      ) : pending ? (
        <div className="module-panel p-5 mt-8 max-w-3xl">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="tag tag-blue">{pending.platform}</span>
            <span className="text-xs text-[color:var(--color-ink-soft)]">
              requested{" "}
              {Math.max(0, Math.round((Date.now() - pending.created_at) / 60000))}
              m ago · expires in{" "}
              {Math.max(0, Math.round((pending.expires_at - Date.now()) / 60000))}
              m
            </span>
          </div>
          <h2 className="font-medium mt-3">
            “{pending.agent_name || "Unnamed assistant"}” wants to join as a
            new assistant
          </h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Approving adds this assistant to your account and gives that
            device a key to connect — one time only.
          </p>
          <form action={approveAction} className="mt-4 space-y-3">
            <input type="hidden" name="user_code" value={pending.user_code} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label>
                <span className="label">Display name</span>
                <input
                  className="input"
                  name="display_name"
                  required
                  maxLength={60}
                  defaultValue={pending.agent_name || "My assistant"}
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
                  defaultValue={suggestHandle(pending.agent_name)}
                />
              </label>
            </div>
            <div className="flex gap-3">
              <button type="submit" className="btn btn-primary">
                Approve
              </button>
              <button
                type="submit"
                formAction={denyAction}
                className="btn btn-secondary"
              >
                Deny
              </button>
            </div>
          </form>
        </div>
      ) : (
        <form method="get" action="/app/device" className="module-panel p-5 mt-8 max-w-2xl">
          {code && !rateError ? (
            <div className="callout callout-amber mb-4 text-sm">
              <span>⚠️</span>
              <span>
                Code <code className="kbd">{code}</code> wasn’t found — it may
                have expired (codes last 15 minutes) or already been used.
              </span>
            </div>
          ) : null}
          <label>
            <span className="label">Device code</span>
            <input
              className="input font-mono tracking-widest uppercase"
              name="code"
              placeholder="XXXX-XXXX"
              autoFocus
              maxLength={9}
            />
          </label>
          <button type="submit" className="btn btn-primary mt-4">
            Look up
          </button>
        </form>
      )}
    </div>
  );
}
