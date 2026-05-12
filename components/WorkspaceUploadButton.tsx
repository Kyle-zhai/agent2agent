"use client";

import { useRef, useState } from "react";

/**
 * One-click file upload.
 *
 * The native <input type="file">'s "Choose files / No file chosen" label is
 * rendered by the OS in the system language (Chinese on a zh-CN macOS, etc.)
 * and cannot be restyled. We hide it with `sr-only` and wrap it in a <label>
 * — clicking the label is the most reliable way to trigger the OS picker
 * across browsers, more so than synthetic `.click()` from a button.
 *
 * On file selection, we update local state and submit the form via
 * `requestSubmit()`. We schedule the submit in a `requestAnimationFrame`
 * so React has flushed the input's value into the form DOM before submit
 * — otherwise the FormData snapshot can miss the files on some browsers.
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
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "selected"; count: number; sample: string }
    | { kind: "uploading"; count: number }
  >({ kind: "idle" });

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        // Snapshot file count for the pending UI.
        const fs = fd.getAll("files");
        const realFiles = fs.filter((f) => f instanceof File && f.size > 0);
        setStatus({ kind: "uploading", count: realFiles.length });
        try {
          await action(fd);
        } finally {
          setStatus({ kind: "idle" });
        }
      }}
      className="surface p-3 flex items-center gap-2"
    >
      <input type="hidden" name="conversation_id" value={convId} />
      <input type="hidden" name="workspace_id" value={wsId} />

      <label className="btn btn-primary btn-sm cursor-pointer inline-flex items-center gap-1.5">
        <span>⬆</span>
        <span>Upload local files</span>
        <input
          type="file"
          name="files"
          multiple
          className="sr-only"
          // Re-set value on every click so re-selecting the same file fires onChange.
          onClick={(e) => {
            (e.currentTarget as HTMLInputElement).value = "";
          }}
          onChange={(e) => {
            const fs = e.currentTarget.files;
            if (!fs || fs.length === 0) return;
            const arr = Array.from(fs);
            setStatus({
              kind: "selected",
              count: arr.length,
              sample: arr[0].name,
            });
            // Wait one frame so the input's selected files are reflected in
            // the form before serialization.
            requestAnimationFrame(() => {
              formRef.current?.requestSubmit();
            });
          }}
        />
      </label>

      <span className="text-[11px] text-[color:var(--color-ink-soft)] flex-1 truncate">
        {status.kind === "uploading"
          ? `Uploading ${status.count} file${status.count === 1 ? "" : "s"}…`
          : status.kind === "selected"
            ? `${status.count} file${status.count === 1 ? "" : "s"} (${status.sample})`
            : "Pick files from your computer."}
      </span>
    </form>
  );
}
