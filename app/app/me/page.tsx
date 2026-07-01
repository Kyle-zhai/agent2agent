import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  changePassword,
  requireUser,
  setInitialPassword,
  userHasPassword,
} from "@/lib/auth";
import {
  clearUserAvatar,
  getUserExtended,
  setUserAvatarFromUpload,
  updateUserDisplayName,
} from "@/lib/users";

export const dynamic = "force-dynamic";

async function updateNameAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const name = String(formData.get("display_name") ?? "");
  try {
    updateUserDisplayName(user.id, name);
  } catch (err) {
    redirect(
      `/app/me?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Update failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/me?ok=Saved`);
}

async function uploadAvatarAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/app/me?err=${encodeURIComponent("Pick a file first.")}`);
  }
  const f = file as File;
  if (f.size > 1024 * 1024) {
    redirect(`/app/me?err=${encodeURIComponent("Avatar must be ≤1 MB.")}`);
  }
  try {
    const bytes = Buffer.from(await f.arrayBuffer());
    setUserAvatarFromUpload(
      user.id,
      bytes,
      f.type || "application/octet-stream",
    );
  } catch (err) {
    redirect(
      `/app/me?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Upload failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/me?ok=Avatar+updated`);
}

async function clearAvatarAction() {
  "use server";
  const user = await requireUser();
  clearUserAvatar(user.id);
  revalidatePath("/app", "layout");
  redirect(`/app/me?ok=Avatar+cleared`);
}

async function changePasswordAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const oldPassword = String(formData.get("old_password") ?? "");
  const newPassword = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");
  const hadPassword = userHasPassword(user.id);
  if (newPassword !== confirm) {
    redirect(`/app/me?err=${encodeURIComponent("New password and confirmation don't match.")}`);
  }
  try {
    if (hadPassword) {
      await changePassword(user.id, oldPassword, newPassword);
    } else {
      await setInitialPassword(user.id, newPassword);
    }
  } catch (err) {
    redirect(
      `/app/me?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not change password.",
      )}`,
    );
  }
  redirect(
    hadPassword
      ? `/app/me?ok=Password+changed+%E2%80%94+other+sessions+signed+out`
      : `/app/me?ok=Password+set`,
  );
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireUser();
  const ext = getUserExtended(user.id);
  const hasPassword = userHasPassword(user.id);
  const { ok, err } = await searchParams;
  return (
    <div className="app-stage">
      <Link
        href="/app/settings"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Settings
      </Link>
      <header className="mt-4 page-header-row">
        <div>
          <div className="page-kicker">Account</div>
          <h1 className="page-title">Your profile</h1>
          <p className="page-subtitle">
            Update your identity, avatar, and password for the assistants and
            workspaces tied to this account.
          </p>
        </div>
      </header>

      {ok ? (
        <div className="callout callout-green mt-4 text-sm">
          <span>✓</span><span>{ok}</span>
        </div>
      ) : null}
      {err ? (
        <div className="callout callout-amber mt-4 text-sm">
          <span>⚠️</span><span>{err}</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(360px,.7fr)_minmax(0,1.3fr)]">
      <section className="module-panel p-6 flex items-center gap-5">
        {ext.avatar_blob_path ? (
          <img
            src={`/api/v1/avatars/me?v=${ext.avatar_blob_path.length}`}
            alt=""
            className="w-20 h-20 rounded-full object-cover border border-[color:var(--color-line)]"
          />
        ) : (
          <div className="w-20 h-20 rounded-full bg-[color:var(--color-tint-blue)] flex items-center justify-center text-3xl">
            🧑
          </div>
        )}
        <div className="flex-1">
          <form action={uploadAvatarAction} className="flex items-center gap-2">
            <input
              type="file"
              name="avatar"
              accept="image/png,image/jpeg,image/webp"
              className="text-sm"
            />
            <button type="submit" className="btn btn-secondary">Upload</button>
          </form>
          {ext.avatar_blob_path ? (
            <form action={clearAvatarAction} className="mt-2">
              <button type="submit" className="btn btn-ghost btn-sm">
                Remove
              </button>
            </form>
          ) : null}
          <p className="text-xs text-[color:var(--color-ink-soft)] mt-2">
            PNG / JPEG / WebP, up to 1 MB. The file type is checked on upload.
          </p>
        </div>
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">Display name</h2>
        <form action={updateNameAction} className="flex items-center gap-2">
          <input
            name="display_name"
            defaultValue={user.display_name}
            maxLength={60}
            className="input flex-1"
            required
          />
          <button type="submit" className="btn btn-primary">Save</button>
        </form>
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-2">Email</h2>
        <code className="kbd">{user.email}</code>
        <p className="text-xs text-[color:var(--color-ink-soft)] mt-2">
          Changing your email isn't supported yet.
        </p>
      </section>

      <section className="module-panel p-6">
        <h2 className="font-medium mb-3">
          {hasPassword ? "Change password" : "Set password"}
        </h2>
        <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
          {hasPassword
            ? "Other sessions are signed out automatically after a successful change."
            : "Add a password so you can sign in without an OAuth provider."}
        </p>
        <form action={changePasswordAction} className="space-y-3">
          {hasPassword ? (
            <label className="block">
              <span className="label">Current password</span>
              <input
                type="password"
                name="old_password"
                required
                className="input"
                autoComplete="current-password"
              />
            </label>
          ) : null}
          <label className="block">
            <span className="label">New password</span>
            <input
              type="password"
              name="new_password"
              required
              minLength={10}
              className="input"
              autoComplete="new-password"
              placeholder="≥10 chars · 3 of: a-z, A-Z, 0-9, symbol"
            />
          </label>
          <label className="block">
            <span className="label">Confirm new password</span>
            <input
              type="password"
              name="confirm_password"
              required
              minLength={10}
              className="input"
              autoComplete="new-password"
            />
          </label>
          <button type="submit" className="btn btn-primary">
            Update password
          </button>
        </form>
      </section>
      </div>
    </div>
  );
}
