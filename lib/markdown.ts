// Tiny zero-dep markdown lexer for inline message text.
// Supports: **bold**, *italic*, `code`, ```code blocks```, [text](url), URLs.
// Output is an array of nodes — caller renders as React text/elements.
// Safety: URLs are filtered (http/https/mailto only); nothing else can
// break out of the tree.

export type MdNode =
  | { type: "text"; value: string }
  | { type: "bold"; children: MdNode[] }
  | { type: "italic"; children: MdNode[] }
  | { type: "code"; value: string }
  | { type: "codeblock"; value: string; lang?: string }
  | { type: "link"; href: string; children: MdNode[] }
  | { type: "br" };

const URL_RE = /\b(https?:\/\/[^\s<>"]+)/g;
const CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /(^|[^*])\*([^*\n]+)\*(?!\*)/g;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n\s]+)\)/g;
const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;

export function parseMarkdown(input: string): MdNode[] {
  if (!input) return [];
  const blocks: MdNode[] = [];
  let lastIdx = 0;
  for (const m of input.matchAll(FENCE_RE)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) blocks.push(...parseInline(input.slice(lastIdx, idx)));
    blocks.push({ type: "codeblock", lang: m[1] || undefined, value: m[2] });
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < input.length) blocks.push(...parseInline(input.slice(lastIdx)));
  return blocks;
}

function parseInline(text: string): MdNode[] {
  const lines = text.split(/\n/);
  const out: MdNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push({ type: "br" });
    out.push(...parseInlineLine(lines[i]));
  }
  return out;
}

function parseInlineLine(line: string): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  while (i < line.length) {
    const next = findNextToken(line, i);
    if (!next) {
      pushText(out, line.slice(i));
      break;
    }
    if (next.start > i) pushText(out, line.slice(i, next.start));
    switch (next.kind) {
      case "code":
        out.push({ type: "code", value: next.body });
        i = next.end;
        break;
      case "bold":
        out.push({ type: "bold", children: parseInlineLine(next.body) });
        i = next.end;
        break;
      case "italic":
        out.push({ type: "italic", children: parseInlineLine(next.body) });
        i = next.end;
        break;
      case "link":
        if (isSafeUrl(next.href)) {
          out.push({
            type: "link",
            href: next.href,
            children: parseInlineLine(next.body),
          });
        } else {
          pushText(out, next.body);
        }
        i = next.end;
        break;
      case "url":
        if (isSafeUrl(next.href)) {
          out.push({
            type: "link",
            href: next.href,
            children: [{ type: "text", value: next.href }],
          });
        } else {
          pushText(out, next.href);
        }
        i = next.end;
        break;
    }
  }
  return out;
}

type Token =
  | { kind: "code"; start: number; end: number; body: string }
  | { kind: "bold"; start: number; end: number; body: string }
  | { kind: "italic"; start: number; end: number; body: string }
  | { kind: "link"; start: number; end: number; body: string; href: string }
  | { kind: "url"; start: number; end: number; href: string };

function findNextToken(line: string, from: number): Token | null {
  const slice = line.slice(from);
  const candidates: Token[] = [];

  const code = firstMatch(slice, CODE_RE);
  if (code) {
    candidates.push({
      kind: "code",
      start: from + (code.index ?? 0),
      end: from + (code.index ?? 0) + code[0].length,
      body: code[1],
    });
  }
  const bold = firstMatch(slice, BOLD_RE);
  if (bold) {
    candidates.push({
      kind: "bold",
      start: from + (bold.index ?? 0),
      end: from + (bold.index ?? 0) + bold[0].length,
      body: bold[1],
    });
  }
  const italic = firstMatch(slice, ITALIC_RE);
  if (italic) {
    const offset = italic[1] ? italic[1].length : 0;
    const start = from + (italic.index ?? 0) + offset;
    candidates.push({
      kind: "italic",
      start,
      end: start + italic[2].length + 2,
      body: italic[2],
    });
  }
  const link = firstMatch(slice, LINK_RE);
  if (link) {
    candidates.push({
      kind: "link",
      start: from + (link.index ?? 0),
      end: from + (link.index ?? 0) + link[0].length,
      body: link[1],
      href: link[2],
    });
  }
  const url = firstMatch(slice, URL_RE);
  if (url) {
    candidates.push({
      kind: "url",
      start: from + (url.index ?? 0),
      end: from + (url.index ?? 0) + url[0].length,
      href: url[1],
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0];
}

function firstMatch(s: string, re: RegExp): RegExpMatchArray | null {
  for (const m of s.matchAll(re)) return m;
  return null;
}

function pushText(out: MdNode[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") {
    last.value += text;
  } else {
    out.push({ type: "text", value: text });
  }
}

function isSafeUrl(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}
