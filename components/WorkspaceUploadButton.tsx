"use client";

import { useRef, useState } from "react";

/**
 * Two-step but bulletproof upload flow:
 *   1. Click "Pick files" → OS file picker
 *   2. Selected file names show; click "Upload" → server action runs
 *
 * Auto-submit via `requestSubmit()` on file change was unreliable in some
 * browsers / HMR states — `<form action={serverAction}>` was getting hit
 * before React's onSubmit pipeline saw the file inputs. A real <button
 * type="submit"> is the path Next.js guarantees to work for Server Actions.
 *
 * The native input still has its OS-locale "Choose files / No file chosen"
 * label, so we hide it with `sr-only` and render our own button instead.
 */
export function WorkspaceUploadButton({
  convId,
  wsId,
  action,
}: {
  convId: string;
  wsId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string[]>([]);

  return (
    <form
      action={action}
      className="surface p-3 flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="conversation_id" value={convId} />
      <input type="hidden" name="workspace_id" value={wsId} />

      <label className="btn btn-secondary btn-sm cursor-pointer inline-flex items-center gap-1.5">
        <span>📁</span>
        <span>Pick files</span>
        <input
          ref={inputRef}
          type="file"
          name="files"
          multiple
          className="sr-only"
          onChange={(e) => {
            const fs = e.currentTarget.files;
            setPicked(fs ? Array.from(fs).map((f) => f.name) : []);
          }}
        />
      </label>

      <button
        type="submit"
        disabled={picked.length === 0}
        className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
      >
        <span>⬆</span>
        <span>
          Upload{picked.length > 0 ? ` (${picked.length})` : ""}
        </span>
      </button>

      <span className="text-[11px] text-[color:var(--color-ink-soft)] flex-1 truncate">
        {picked.length === 0
          ? "Pick local files, then click Upload."
          : picked.length === 1
            ? picked[0]
            : `${picked.length} files: ${picked.slice(0, 2).join(", ")}${picked.length > 2 ? "…" : ""}`}
      </span>
    </form>
  );
}
