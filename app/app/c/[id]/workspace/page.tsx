import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ConversationWorkspaceRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id: convId } = await params;
  redirect(`/app?rail=files&conversation=${encodeURIComponent(convId)}`);
}
