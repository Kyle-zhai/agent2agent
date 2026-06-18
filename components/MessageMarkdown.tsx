"use client";
import { Fragment } from "react";
import { parseMarkdown, type MdNode } from "@/lib/markdown";

export function MessageMarkdown({
  text,
  memberHandles = [],
}: {
  text: string;
  memberHandles?: string[];
}) {
  const nodes = parseMarkdown(text);
  return <>{renderNodes(nodes, new Set(memberHandles.map((h) => h.toLowerCase())))}</>;
}

function renderNodes(nodes: MdNode[], handles: Set<string>): React.ReactNode {
  return nodes.map((n, i) => (
    <Fragment key={i}>{renderNode(n, handles)}</Fragment>
  ));
}

function renderNode(n: MdNode, handles: Set<string>): React.ReactNode {
  switch (n.type) {
    case "text":
      return renderTextWithMentions(n.value, handles);
    case "br":
      return <br />;
    case "bold":
      return <strong>{renderNodes(n.children, handles)}</strong>;
    case "italic":
      return <em>{renderNodes(n.children, handles)}</em>;
    case "code":
      return (
        <code className="bg-black/[0.06] dark:bg-white/[0.08] px-1 py-0.5 rounded text-[0.9em] font-mono">
          {n.value}
        </code>
      );
    case "codeblock":
      return (
        <pre className="bg-black/[0.06] dark:bg-white/[0.08] p-3 rounded my-1.5 overflow-x-auto text-[12.5px] font-mono leading-[1.5]">
          <code>{n.value}</code>
        </pre>
      );
    case "link":
      return (
        <a
          href={n.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2 font-medium decoration-[1.5px]"
        >
          {renderNodes(n.children, handles)}
        </a>
      );
  }
}

function renderTextWithMentions(
  text: string,
  handles: Set<string>,
): React.ReactNode {
  if (handles.size === 0 || !text.includes("@")) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/@([a-z][a-z0-9-]{1,29})\b/g)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const handle = m[1];
    if (handles.has(handle.toLowerCase())) {
      out.push(
        <span
          key={idx}
          className="bg-[color:var(--color-tint-blue)] text-[color:var(--color-tint-blue-ink)] px-1 rounded font-medium"
          title={`Mention: @${handle}`}
        >
          @{handle}
        </span>,
      );
    } else {
      out.push(`@${handle}`);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

