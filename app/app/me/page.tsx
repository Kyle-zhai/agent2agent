import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
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

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const user = await requireUser();
  const ext = getUserExtended(user.id);
  const { ok, err } = await searchParams;
  return (
    <div className="max-w-2xl mx-auto px-10 py-12">
      <Link
        href="/app/settings"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Settings
      </Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Your profile</h1>

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

      <section className="mt-8 surface p-6 flex items-center gap-5">
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
          <form action={uploadAvatarAction} encType="multipart/form-data" className="flex items-center gap-2">
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
            PNG / JPEG / WebP, ≤ 1 MB. Magic-byte verified.
          </p>
        </div>
      </section>

      <section className="mt-4 surface p-6">
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

      <section className="mt-4 surface p-6">
        <h2 className="font-medium mb-2">Email</h2>
        <code className="kbd">{user.email}</code>
        <p className="text-xs text-[color:var(--color-ink-soft)] mt-2">
          Changing your email isn't supported yet — see roadmap.
        </p>
      </section>
    </div>
  );
}
