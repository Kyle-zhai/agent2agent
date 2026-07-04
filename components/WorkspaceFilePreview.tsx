"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import {
  getDemoWorkspaceItems,
  getDemoWorkspaceProfile,
  type DemoWorkspaceItem,
} from "@/lib/demo-workspace";

// ---------------------------------------------------------------------------
// Center-panel file preview. The interaction model:
//   right rail = chat by default → click the Files icon → click a file →
//   the selected file renders HERE, in the center, in a format-appropriate
//   preview. Nothing is shown until a file is selected (empty state below).
// Driven entirely by the URL (?conversation=…&previewFile=…) so the rail and
// this panel stay in sync via a single source of truth.
// ---------------------------------------------------------------------------

export function WorkspaceFilePreview() {
  const searchParams = useSearchParams();
  const convKey = searchParams.get("conversation");
  const previewPath = searchParams.get("previewFile");
  const profile = getDemoWorkspaceProfile(convKey);
  const items = getDemoWorkspaceItems(convKey);

  const file =
    previewPath != null
      ? items.find((f) => f.path === previewPath && f.kind !== "folder") ?? null
      : null;

  if (!file) {
    return <EmptyState title={profile.title} fileCount={items.filter((f) => f.kind !== "folder").length} />;
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <PreviewHeader file={file} />
      <div className="min-h-0 flex-1 overflow-auto">
        <FileBody file={file} />
      </div>
    </div>
  );
}

function PreviewHeader({ file }: { file: DemoWorkspaceItem }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-line)] px-5 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold text-[color:var(--color-ink)]">
          {file.name}
        </h2>
        <p className="truncate text-[11px] text-[color:var(--color-ink-soft)]">{file.path}</p>
      </div>
      <span className="shrink-0 rounded-full bg-[color:var(--color-paper-faint)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {kindLabel(file.kind)}
      </span>
    </div>
  );
}

function FileBody({ file }: { file: DemoWorkspaceItem }) {
  const content = file.content ?? "";
  switch (file.kind) {
    case "md":
      return (
        <div className="prose-notion mx-auto max-w-[760px] px-6 py-6">
          <MarkdownView source={content} />
        </div>
      );
    case "html":
      return <HtmlPreview content={content} name={file.name} />;
    case "csv":
      return <CsvTable content={content} />;
    case "json":
      return <CodeBlock content={content} language="json" />;
    case "css":
      return <CodeBlock content={content} language="css" />;
    case "git":
    case "txt":
    case "agent":
    default:
      return <CodeBlock content={content} language="text" />;
  }
}

/** HTML gets a LIVE rendered preview (sandboxed iframe, scripts disabled) with
 *  a toggle to the raw source — the "preview any format, including running
 *  markup" experience. */
function HtmlPreview({ content, name }: { content: string; name: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[color:var(--color-line)] px-5 py-2">
        <Toggle active={mode === "preview"} label="Preview" onClick={() => setMode("preview")} />
        <Toggle active={mode === "source"} label="Source" onClick={() => setMode("source")} />
      </div>
      {mode === "preview" ? (
        <iframe
          title={`Preview of ${name}`}
          srcDoc={content}
          // allow-same-origin (WITHOUT allow-scripts) lets the markup render
          // under the app's strict default-src CSP while still blocking any
          // script execution — so untrusted preview HTML can style itself but
          // can never run code or reach the parent.
          sandbox="allow-same-origin"
          className="min-h-[560px] w-full flex-1 border-0 bg-white"
        />
      ) : (
        <CodeBlock content={content} language="html" />
      )}
    </div>
  );
}

/** Block-level markdown renderer for document preview. The shared
 *  MessageMarkdown/parseMarkdown handles INLINE only (bold/italic/code/links)
 *  — tuned for chat — so we split blocks (headings, lists, fenced code,
 *  paragraphs) here and delegate inline spans to it. Styled by .prose-notion. */
function MarkdownView({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level, 3)}`) as "h1" | "h2" | "h3";
      blocks.push(
        <Tag key={key++}>
          <MessageMarkdown text={h[2]} />
        </Tag>,
      );
      i++;
      continue;
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, n) => (
            <li key={n}>
              <MessageMarkdown text={it} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((it, n) => (
            <li key={n}>
              <MessageMarkdown text={it} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    // blank line → skip
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph — gather until blank / block boundary
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("```")
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++}>
        <MessageMarkdown text={para.join(" ")} />
      </p>,
    );
  }
  return <>{blocks}</>;
}

function CsvTable({ content }: { content: string }) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  if (rows.length === 0) return <CodeBlock content={content} language="text" />;
  const [head, ...body] = rows;
  return (
    <div className="mx-auto max-w-[760px] px-6 py-6">
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-line)]">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-[color:var(--color-paper-faint)]">
              {head.map((cell, i) => (
                <th
                  key={i}
                  className="border-b border-[color:var(--color-line)] px-3 py-2 text-left font-semibold text-[color:var(--color-ink)]"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="odd:bg-white even:bg-[color:var(--color-paper)]">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="border-b border-[color:var(--color-line)] px-3 py-2 text-[color:var(--color-ink-muted)] last:border-r-0"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  return (
    <div className="px-5 py-5">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101729]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-white/50">
            {language}
          </span>
          <span className="text-[11px] text-white/40">read-only</span>
        </div>
        <pre className="overflow-auto p-4 text-[12.5px] leading-relaxed text-[#d8e3ff]">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
}

function EmptyState({ title, fileCount }: { title: string; fileCount: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-[color:var(--color-paper)] px-8 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border border-[color:var(--color-line)] bg-white text-[color:var(--color-ink-soft)]">
        <FileGlyph />
      </div>
      <h2 className="mt-5 text-[16px] font-semibold text-[color:var(--color-ink)]">{title}</h2>
      <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-[color:var(--color-ink-muted)]">
        Open the <span className="font-medium text-[color:var(--color-ink)]">Files</span> panel on the
        right and pick a file — it previews here in the center, whatever the format.
      </p>
      <p className="mt-3 text-[11px] text-[color:var(--color-ink-soft)]">
        {fileCount} file{fileCount === 1 ? "" : "s"} in this workspace
      </p>
    </div>
  );
}

function Toggle({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-lg px-3 py-1 text-[12px] font-medium " +
        (active
          ? "bg-[#eef4ff] text-[color:var(--color-tint-blue-ink)]"
          : "text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)]")
      }
    >
      {label}
    </button>
  );
}

function kindLabel(kind: DemoWorkspaceItem["kind"]): string {
  switch (kind) {
    case "md":
      return "markdown";
    case "html":
      return "html";
    case "csv":
      return "csv";
    case "json":
      return "json";
    case "css":
      return "css";
    case "git":
      return "gitignore";
    case "txt":
      return "text";
    case "agent":
      return "agent";
    default:
      return "file";
  }
}

function FileGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    </svg>
  );
}
