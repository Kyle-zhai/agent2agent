import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function WorkspaceDetailRoute({
  params,
}: {
  params: Promise<{ id: string; wsId: string }>;
}) {
  await requireUser();
  const { id: convId, wsId } = await params;
  redirect(
    `/app?rail=files&conversation=${encodeURIComponent(
      convId,
    )}&workspace=${encodeURIComponent(wsId)}`,
  );
}
