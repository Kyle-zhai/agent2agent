import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { unlinkIdentity } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const user = await requireUser();
  const { provider } = await params;
  try {
    unlinkIdentity(user.id, provider);
  } catch (err) {
    redirect(
      `/app/settings?error=${encodeURIComponent(
        err instanceof Error ? err.message : "unlink failed",
      )}`,
    );
  }
  redirect("/app/settings?ok=unlinked");
}
