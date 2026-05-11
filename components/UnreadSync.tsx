"use client";
import { useEffect } from "react";

/**
 * Sets <body data-unread="N"> on every render to keep NotificationsHook
 * informed. Server-rendered, computed in app/app/layout.tsx.
 */
export function UnreadSync({ count }: { count: number }) {
  useEffect(() => {
    document.body.dataset.unread = String(count);
  }, [count]);
  return null;
}
