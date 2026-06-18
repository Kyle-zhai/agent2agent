"use client";

import { useRef, useState } from "react";

/**
 * Single-button upload with two modes:
 *
 *   1. "Files" — multi-select files (any number, any types)
 *   2. "Folder" — pick a folder and recursively upload everything inside,
 *      preserving the directory structure via webkitRelativePath.
 *
 * The component renders one primary "⬆ Upload" button. Clicking it opens a
 * tiny menu with Files / Folder. Selecting either immediately submits the
 * form to the server action — no separate "confirm" click.
 *
 * Folder structure preservation: the standard `<input type="file">` payload
 * loses webkitRelativePath when serialised to FormData by the browser — only
 * `name` survives. We carry the structure in a sidecar `paths_json` field
 * (JSON-encoded string[] indexed by the file order in `files`). The server
 * action prefers `paths_json` when present.
 *
 * Drag-and-drop on the surface accepts both files AND folders at once. We
 * walk DataTransferItemList recursively to collect everything, then build
 * a fresh FileList-like via DataTransfer so the existing `name="files"` form
 * field carries them. paths_json captures their relative paths.
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pathsJsonRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  function submitForm(fileList: FileList | File[], paths: string[]) {
    if (fileList.length === 0) return;
    const totalBytes = Array.from(fileList).reduce((s, f) => s + f.size, 0);
    setStatusLine(
      `${fileList.length} item${fileList.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} — uploading…`,
    );
    if (pathsJsonRef.current) {
      pathsJsonRef.current.value = JSON.stringify(paths);
    }
    // When we built the file list from drag-and-drop, the <input> element's
    // own .files needs to be replaced via DataTransfer because the form will
    // serialise from the input. The browser only supports DataTransfer-based
    // assignment to input.files; arbitrary File[] won't go through FormData
    // unless attached this way.
    if (fileList instanceof FileList) {
      // already attached to the input that fired onChange — no-op
    } else if (fileInputRef.current) {
      const dt = new DataTransfer();
      for (const f of fileList) dt.items.add(f);
      fileInputRef.current.files = dt.files;
    }
    setSubmitting(true);
    setMenuOpen(false);
    // Defer to next tick so React commits the disabled state before the
    // submit fires (some browsers cancel synchronous requestSubmit + state
    // changes if the form re-renders mid-submit).
    requestAnimationFrame(() => {
      formRef.current?.requestSubmit();
    });
  }

  function pathsFromInput(files: FileList, isFolder: boolean): string[] {
    const out: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (isFolder && f.webkitRelativePath) {
        out.push(f.webkitRelativePath);
      } else {
        out.push(f.name);
      }
    }
    return out;
  }

  async function pathsFromDataTransfer(items: DataTransferItemList): Promise<{
    files: File[];
    paths: string[];
  }> {
    // Walk webkit entries (file/directory). Folders come through as
    // DataTransferItem.webkitGetAsEntry() FileSystemDirectoryEntry; we recurse.
    const files: File[] = [];
    const paths: string[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.() as FileSystemEntry | null;
      if (entry) {
        promises.push(walkEntry(entry, "", files, paths));
      } else {
        const f = items[i].getAsFile();
        if (f) {
          files.push(f);
          paths.push(f.name);
        }
      }
    }
    await Promise.all(promises);
    return { files, paths };
  }

  return (
    <div
      className={
        "surface p-3 transition-colors " +
        (dragging
          ? "border-[color:var(--color-ink)]/60 bg-[color:var(--color-paper-faint)]"
          : "")
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (!submitting) setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        if (submitting) return;
        const { files, paths } = await pathsFromDataTransfer(
          e.dataTransfer.items,
        );
        submitForm(files, paths);
      }}
    >
      <form
        ref={formRef}
        action={action}
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="conversation_id" value={convId} />
        <input type="hidden" name="workspace_id" value={wsId} />
        <input
          ref={pathsJsonRef}
          type="hidden"
          name="paths_json"
          defaultValue=""
        />
        {/* Files input — multi-select, any types. */}
        <input
          ref={fileInputRef}
          type="file"
          name="files"
          multiple
          style={{
            position: "absolute",
            left: "-9999px",
            width: "1px",
            height: "1px",
            opacity: 0,
          }}
          onChange={(e) => {
            const fs = e.currentTarget.files;
            if (!fs || fs.length === 0) return;
            submitForm(fs, pathsFromInput(fs, false));
          }}
        />
        {/* Folder input — webkitdirectory makes the OS prompt for a folder. */}
        <input
          ref={folderInputRef}
          type="file"
          name="files"
          multiple
          // @ts-expect-error non-standard but supported in Chromium/WebKit/Firefox
          webkitdirectory=""
          directory=""
          style={{
            position: "absolute",
            left: "-9999px",
            width: "1px",
            height: "1px",
            opacity: 0,
          }}
          onChange={(e) => {
            const fs = e.currentTarget.files;
            if (!fs || fs.length === 0) return;
            // For folder input, copy files into the main file input so the
            // form serialises through one `files` field consistently.
            if (fileInputRef.current) {
              const dt = new DataTransfer();
              for (let i = 0; i < fs.length; i++) dt.items.add(fs[i]);
              fileInputRef.current.files = dt.files;
            }
            submitForm(fs, pathsFromInput(fs, true));
          }}
        />

        {/* The visible primary button — a tiny menu under it. */}
        <div className="relative">
          <button
            type="button"
            disabled={submitting}
            onClick={() => setMenuOpen((v) => !v)}
            className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          >
            <span>⬆</span>
            <span>{submitting ? "Uploading…" : "Upload"}</span>
            <span className="text-[10px] opacity-70 ml-0.5">▾</span>
          </button>
          {menuOpen && !submitting ? (
            <div
              className="absolute left-0 top-full mt-1 surface shadow-[var(--shadow-pop)] py-1 w-44 z-30"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  fileInputRef.current?.click();
                }}
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
              >
                <span>📄</span>
                <span>Files…</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  folderInputRef.current?.click();
                }}
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
              >
                <span>📁</span>
                <span>Folder…</span>
              </button>
            </div>
          ) : null}
        </div>

        <span className="text-[11px] text-[color:var(--color-ink-soft)] flex-1 truncate">
          {statusLine ?? (
            dragging
              ? "Drop to upload."
              : "Click Upload — or drop files / a folder right here."
          )}
        </span>
      </form>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ──────────────────────────────────────────────────────────────────────────
// File-system entry walker (drag-and-drop folder support)
// ──────────────────────────────────────────────────────────────────────────

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  outFiles: File[],
  outPaths: string[],
): Promise<void> {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      (entry as FileSystemFileEntry).file((f) => {
        outFiles.push(f);
        outPaths.push(prefix ? `${prefix}/${f.name}` : f.name);
        resolve();
      });
    });
    return;
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    // readEntries returns up to ~100 entries per call — loop until empty.
    const children: FileSystemEntry[] = [];
    await new Promise<void>((resolve, reject) => {
      const drain = () => {
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              resolve();
              return;
            }
            children.push(...batch);
            drain();
          },
          (err) => reject(err),
        );
      };
      drain();
    });
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    await Promise.all(
      children.map((c) => walkEntry(c, nextPrefix, outFiles, outPaths)),
    );
  }
}
