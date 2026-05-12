import { collapseContext, diffLines, type DiffLine } from "@/lib/diff";

export function DiffViewer({
  before,
  after,
  path,
  context = 3,
  maxRenderLines = 1000,
}: {
  before: string | null;
  after: string | null;
  path: string;
  context?: number;
  maxRenderLines?: number;
}) {
  if (before === null && after !== null) {
    return <AddedFileView path={path} content={after} maxRenderLines={maxRenderLines} />;
  }
  if (after === null && before !== null) {
    return <DeletedFileView path={path} content={before} maxRenderLines={maxRenderLines} />;
  }
  if (before === null && after === null) return null;
  const res = diffLines(before ?? "", after ?? "");
  if (!res.ok) {
    return (
      <div className="surface p-3 text-[12px] text-[color:var(--color-ink-soft)]">
        <code className="font-mono">{path}</code>
        <div className="mt-1">
          Diff unavailable ({res.reason}). View the raw file instead.
        </div>
      </div>
    );
  }
  const collapsed = collapseContext(res.lines, context);
  return (
    <div className="surface overflow-hidden">
      <div className="px-3 py-2 border-b border-[color:var(--color-line)] flex items-center justify-between text-[12px]">
        <code className="font-mono">{path}</code>
        <span className="text-[color:var(--color-ink-soft)]">
          <span className="text-[color:var(--color-tint-green-ink)]">+{res.added}</span>{" "}
          <span className="text-[color:var(--color-tint-pink-ink)]">−{res.deleted}</span>
        </span>
      </div>
      <pre className="text-[12px] font-mono leading-snug overflow-x-auto m-0">
        {collapsed.slice(0, maxRenderLines).map((row, idx) => {
          if (row.kind === "skip") {
            return (
              <div
                key={`s${idx}`}
                className="px-3 py-1 text-[11px] text-[color:var(--color-ink-soft)] bg-[color:var(--color-canvas)] border-y border-[color:var(--color-line)]"
              >
                … {row.count} unchanged line{row.count === 1 ? "" : "s"} …
              </div>
            );
          }
          return <DiffRow key={idx} row={row} />;
        })}
        {collapsed.length > maxRenderLines ? (
          <div className="px-3 py-2 text-[11px] text-[color:var(--color-ink-soft)] bg-[color:var(--color-canvas)] border-t border-[color:var(--color-line)]">
            … {collapsed.length - maxRenderLines} more diff line(s) truncated …
          </div>
        ) : null}
      </pre>
    </div>
  );
}

function DiffRow({ row }: { row: DiffLine }) {
  const palette =
    row.kind === "add"
      ? "bg-[color:var(--color-tint-green)] text-[color:var(--color-tint-green-ink)]"
      : row.kind === "del"
      ? "bg-[color:var(--color-tint-pink)] text-[color:var(--color-tint-pink-ink)]"
      : "";
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const aLine = row.kind === "add" ? "" : String(row.aLine);
  const bLine = row.kind === "del" ? "" : String(row.bLine);
  return (
    <div className={`grid grid-cols-[40px_40px_18px_1fr] ${palette}`}>
      <span className="px-1 text-right text-[10px] text-[color:var(--color-ink-soft)] select-none">
        {aLine}
      </span>
      <span className="px-1 text-right text-[10px] text-[color:var(--color-ink-soft)] select-none">
        {bLine}
      </span>
      <span className="text-center select-none">{marker}</span>
      <span className="px-2 whitespace-pre-wrap break-all">{row.text || " "}</span>
    </div>
  );
}

function AddedFileView({
  path,
  content,
  maxRenderLines,
}: {
  path: string;
  content: string;
  maxRenderLines: number;
}) {
  const lines = content.split(/\r?\n/);
  return (
    <div className="surface overflow-hidden">
      <div className="px-3 py-2 border-b border-[color:var(--color-line)] flex items-center justify-between text-[12px]">
        <code className="font-mono">{path}</code>
        <span className="tag tag-green">added · {lines.length} lines</span>
      </div>
      <pre className="text-[12px] font-mono leading-snug overflow-x-auto m-0 bg-[color:var(--color-tint-green)]">
        {lines.slice(0, maxRenderLines).map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-[40px_18px_1fr] text-[color:var(--color-tint-green-ink)]"
          >
            <span className="px-1 text-right text-[10px] text-[color:var(--color-ink-soft)] select-none">
              {i + 1}
            </span>
            <span className="text-center select-none">+</span>
            <span className="px-2 whitespace-pre-wrap break-all">{t || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function DeletedFileView({
  path,
  content,
  maxRenderLines,
}: {
  path: string;
  content: string;
  maxRenderLines: number;
}) {
  const lines = content.split(/\r?\n/);
  return (
    <div className="surface overflow-hidden">
      <div className="px-3 py-2 border-b border-[color:var(--color-line)] flex items-center justify-between text-[12px]">
        <code className="font-mono">{path}</code>
        <span className="tag tag-pink">deleted · {lines.length} lines</span>
      </div>
      <pre className="text-[12px] font-mono leading-snug overflow-x-auto m-0 bg-[color:var(--color-tint-pink)]">
        {lines.slice(0, maxRenderLines).map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-[40px_18px_1fr] text-[color:var(--color-tint-pink-ink)]"
          >
            <span className="px-1 text-right text-[10px] text-[color:var(--color-ink-soft)] select-none">
              {i + 1}
            </span>
            <span className="text-center select-none">−</span>
            <span className="px-2 whitespace-pre-wrap break-all">{t || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
