import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../../lib/markdown";

describe("parseMarkdown XSS allowlist", () => {
  it("rejects javascript: URLs in [text](href) and falls back to text", () => {
    const out = parseMarkdown("[click](javascript:alert(1))");
    // The link node should NOT be emitted. The lexer's href pattern stops
    // at the first `)`, so the match consumes "[click](javascript:alert(1"
    // and leaves the trailing `)` as text — that's fine, the critical
    // assertion is "no link node and no anchor href reaches the renderer."
    assert.ok(
      !out.some((n) => n.type === "link"),
      "must not produce a link for a javascript: URL",
    );
    const flat = out
      .filter((n) => n.type === "text")
      .map((n) => (n as { type: "text"; value: string }).value)
      .join("");
    assert.ok(
      !flat.includes("javascript:"),
      "the raw javascript: scheme must not appear in rendered text",
    );
  });

  it("rejects data: URLs", () => {
    const out = parseMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    assert.equal(out[0].type, "text");
  });

  it("rejects vbscript: URLs", () => {
    const out = parseMarkdown("[x](vbscript:msgbox)");
    assert.equal(out[0].type, "text");
  });

  it("accepts http and https URLs", () => {
    const a = parseMarkdown("[x](http://example.com)");
    const b = parseMarkdown("[x](https://example.com)");
    assert.equal(a[0].type, "link");
    assert.equal(b[0].type, "link");
  });

  it("accepts mailto: URLs", () => {
    const out = parseMarkdown("[mail](mailto:a@b.example)");
    assert.equal(out[0].type, "link");
  });

  it("linkifies bare https URLs in text", () => {
    const out = parseMarkdown("see https://example.com/x for more");
    const link = out.find((n) => n.type === "link");
    assert.ok(link, "should have at least one link node");
  });

  it("does not linkify file: URLs", () => {
    const out = parseMarkdown("path file:///etc/passwd here");
    assert.ok(
      !out.some((n) => n.type === "link"),
      "must not turn file:// into a clickable link",
    );
  });

  it("renders **bold** and *italic* and `code` as discrete nodes", () => {
    const out = parseMarkdown("**hi** *there* `code`");
    const kinds = out.map((n) => n.type);
    assert.ok(kinds.includes("bold"));
    assert.ok(kinds.includes("italic"));
    assert.ok(kinds.includes("code"));
  });

  it("handles fenced code blocks with lang", () => {
    const out = parseMarkdown("```sql\nSELECT 1;\n```");
    assert.equal(out[0].type, "codeblock");
    const cb = out[0] as { type: "codeblock"; lang?: string; value: string };
    assert.equal(cb.lang, "sql");
    assert.match(cb.value, /SELECT 1/);
  });

  it("never produces inner-html-style strings (only typed nodes)", () => {
    // The output is a discriminated union of nodes — caller renders as
    // React. There is no place to inject raw HTML.
    const out = parseMarkdown("<script>alert(1)</script>");
    for (const node of out) {
      assert.ok(["text", "br"].includes(node.type));
    }
  });
});
