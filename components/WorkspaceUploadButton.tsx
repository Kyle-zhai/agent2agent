"use client";

import { useRef, useState } from "react";

/**
 * One-click file upload. Hides the native <input type="file"> (whose label
 * follows the OS locale and shows Chinese on a zh system) behind a styled
 * button. On selection, submits the form immediately — no separate upload
 * button or prefix to fill in.
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
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <form
      ref={formRef}
      action={action}
      className="surface p-3 flex items-center gap-2"
    >
      <input type="hidden" name="conversation_id" value={convId} />
      <input type="hidden" name="workspace_id" value={wsId} />
      {/* Native input is hidden — its locale-bound label is replaced by the
          button below. multiple lets the user pick many files at once. */}
      <input
        ref={inputRef}
        type="file"
        name="files"
        multiple
        className="sr-only"
        onChange={(e) => {
          const fs = e.currentTarget.files;
          if (!fs || fs.length === 0) {
            setPicked(null);
            return;
          }
          setPicked(
            fs.length === 1
              ? fs[0].name
              : `${fs.length} files`,
          );
          // Submit immediately — no extra step needed.
          formRef.current?.requestSubmit();
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="btn btn-primary btn-sm flex items-center gap-1.5"
      >
        ⬆ Upload local files
      </button>
      <span className="text-[11px] text-[color:var(--color-ink-soft)] flex-1 truncate">
        {picked ? `Uploading ${picked}…` : "Pick files from your computer."}
      </span>
    </form>
  );
}
