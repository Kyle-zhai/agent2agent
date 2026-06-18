import { Fragment } from "react";
import { MessageMarkdown } from "@/components/MessageMarkdown";

/** Document-style markdown renderer for the workspace file viewer (Lark-like
 *  reading view). The chat renderer (MessageMarkdown / lib/markdown.ts) is
 *  inline-only by design — messages never grow headings. Files DO: this
 *  component handles the block layer (headings, lists, quotes, fenced code,
 *  pipe tables, rules) and delegates inline markup (bold/italic/code/links)
 *  to MessageMarkdown per block. Server component — no client state.
 *
 *  Deliberately small: unknown constructs fall back to plain paragraphs, so
 *  a weird file degrades to readable text, never to an error. */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

function splitTableRow(line: string): string[] {
  // | a | b | → ["a","b"]; tolerate missing outer pipes.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  // | --- | :--: | ----- |
  const t = line.trim();
  if (!t.includes("-")) return false;
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(t);
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (t === "") {
      i++;
      continue;
    }
    // fenced code
    const fence = t.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    // heading
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: h[2] });
      i++;
      continue;
    }
    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    // blockquote (consecutive > lines)
    if (t.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        body.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    // unordered list
    if (/^[-*+]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // ordered list
    if (/^\d+[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // pipe table (header row + separator row)
    if (t.startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitTableRow(lines[i]);
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    // paragraph: gather until blank line or a structural line
    const body: string[] = [];
    while (i < lines.length) {
      const lt = lines[i].trim();
      if (
        lt === "" ||
        /^(#{1,6})\s+/.test(lt) ||
        lt.startsWith(">") ||
        /^[-*+]\s+/.test(lt) ||
        /^\d+[.)]\s+/.test(lt) ||
        lt.startsWith("```") ||
        (lt.startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        if (body.length > 0) break;
      }
      if (lt === "") break;
      body.push(lines[i]);
      i++;
      // structural line right after starting a paragraph: stop before it next loop
      if (
        i < lines.length &&
        (/^(#{1,6})\s+/.test(lines[i].trim()) || lines[i].trim().startsWith("```"))
      ) {
        break;
      }
    }
    if (body.length > 0) {
      blocks.push({ kind: "paragraph", text: body.join("\n") });
    } else {
      i++; // safety: never stall
    }
  }
  return blocks;
}

function Inline({ text }: { text: string }) {
  return <MessageMarkdown text={text} />;
}

export function MarkdownDoc({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md-doc">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const cls =
              b.level === 1
                ? "text-xl font-semibold mt-5 mb-2 first:mt-0"
                : b.level === 2
                  ? "text-lg font-semibold mt-4 mb-1.5 first:mt-0"
                  : "text-[15px] font-semibold mt-3 mb-1 first:mt-0";
            if (b.level === 1)
              return (
                <h1 key={i} className={cls}>
                  <Inline text={b.text} />
                </h1>
              );
            if (b.level === 2)
              return (
                <h2 key={i} className={cls}>
                  <Inline text={b.text} />
                </h2>
              );
            return (
              <h3 key={i} className={cls}>
                <Inline text={b.text} />
              </h3>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="my-1.5">
                <Inline text={b.text} />
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc pl-5 my-1.5 space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal pl-5 my-1.5 space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-[color:var(--color-line)] pl-3 my-2 text-[color:var(--color-ink-muted)]"
              >
                <Inline text={b.text} />
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={i}
                className="bg-[color:var(--color-canvas)] p-3 rounded-lg overflow-x-auto my-2 text-[12.5px] font-mono leading-[1.55]"
              >
                {b.text}
              </pre>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto my-2">
                <table className="text-[13px] border-collapse w-full">
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th
                          key={j}
                          className="text-left font-semibold px-3 py-1.5 bg-[color:var(--color-paper-strong)] border border-[color:var(--color-line)]"
                        >
                          <Inline text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className="px-3 py-1.5 border border-[color:var(--color-line)] align-top"
                          >
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return (
              <hr key={i} className="my-4 border-[color:var(--color-line)]" />
            );
          default:
            return <Fragment key={i} />;
        }
      })}
    </div>
  );
}
