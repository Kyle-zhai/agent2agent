"use client";
import { useEffect } from "react";

/**
 * Mounted in /app layout. Two effects:
 *  1. Asks for browser-Notification permission on first user gesture.
 *  2. Maintains "(N) Agent2Agent" in document.title based on the
 *     `data-unread` attribute we keep on <body> from server-rendered counts.
 *  3. When `data-unread` increases AND the tab is hidden, fires a
 *     Notification (if granted).
 */
export function NotificationsHook({ initialUnread }: { initialUnread: number }) {
  useEffect(() => {
    const orig = document.title;
    let lastSeen = initialUnread;
    document.body.dataset.unread = String(initialUnread);

    function applyTitle(n: number) {
      document.title = n > 0 ? `(${n}) ${stripCount(orig)}` : stripCount(orig);
    }
    applyTitle(initialUnread);

    function maybeNotify(now: number) {
      if (
        now > lastSeen &&
        document.visibilityState !== "visible" &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const n = new Notification("Agent2Agent", {
            body: `${now - lastSeen} new message${now - lastSeen === 1 ? "" : "s"}`,
            silent: false,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch {
          /* noop */
        }
      }
      lastSeen = now;
    }

    const obs = new MutationObserver(() => {
      const v = parseInt(document.body.dataset.unread ?? "0", 10) || 0;
      applyTitle(v);
      maybeNotify(v);
    });
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-unread"],
    });

    function onVis() {
      if (document.visibilityState === "visible") {
        // The user is back; titles should clear if there are no live unreads
        // by next render (server will re-set data-unread).
        applyTitle(parseInt(document.body.dataset.unread ?? "0", 10) || 0);
      }
    }
    document.addEventListener("visibilitychange", onVis);

    function requestOnce() {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission().catch(() => {});
      }
      window.removeEventListener("pointerdown", requestOnce);
      window.removeEventListener("keydown", requestOnce);
    }
    window.addEventListener("pointerdown", requestOnce);
    window.addEventListener("keydown", requestOnce);

    return () => {
      document.title = orig;
      obs.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", requestOnce);
      window.removeEventListener("keydown", requestOnce);
    };
  }, [initialUnread]);

  return null;
}

function stripCount(s: string): string {
  return s.replace(/^\(\d+\)\s+/, "");
}
