"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_KINDS = new Set([
  "message",
  "edit",
  "delete",
  "react",
  "title_change",
  "member_add",
  "member_remove",
  "workspace.changed",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.commented",
]);

export function ConversationSSE({
  convId,
  relevantKinds,
}: {
  convId: string;
  relevantKinds?: string[];
}) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;
    const filter = relevantKinds ? new Set(relevantKinds) : REFRESH_KINDS;

    function startPolling() {
      pollTimer = window.setInterval(() => {
        if (cancelled) return;
        if (document.visibilityState === "visible") router.refresh();
      }, 5000);
    }

    try {
      es = new EventSource(`/api/v1/conversations/${convId}/stream`);
      es.addEventListener("message", (ev: MessageEvent) => {
        if (cancelled) return;
        let parsed: { kind?: string } = {};
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (parsed.kind && !filter.has(parsed.kind)) return;
        if (document.visibilityState === "visible") router.refresh();
      });
      es.addEventListener("error", () => {
        if (!cancelled && pollTimer === null) startPolling();
      });
    } catch {
      startPolling();
    }
    return () => {
      cancelled = true;
      if (es) es.close();
      if (pollTimer != null) window.clearInterval(pollTimer);
    };
  }, [convId, router, relevantKinds]);

  return null;
}
