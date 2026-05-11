"use client";
import { Fragment } from "react";
import { parseMarkdown, type MdNode } from "@/lib/markdown";

export function MessageMarkdown({ text }: { text: string }) {
  const nodes = parseMarkdown(text);
  return <>{renderNodes(nodes)}</>;
}

function renderNodes(nodes: MdNode[]): React.ReactNode {
  return nodes.map((n, i) => <Fragment key={i}>{renderNode(n)}</Fragment>);
}

function renderNode(n: MdNode): React.ReactNode {
  switch (n.type) {
    case "text":
      return n.value;
    case "br":
      return <br />;
    case "bold":
      return <strong>{renderNodes(n.children)}</strong>;
    case "italic":
      return <em>{renderNodes(n.children)}</em>;
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
          className="text-[color:var(--color-tint-blue-ink)] underline underline-offset-2"
        >
          {renderNodes(n.children)}
        </a>
      );
  }
}
