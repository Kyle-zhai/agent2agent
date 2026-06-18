import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { merge3, isMergeableText } from "../../lib/merge3";

describe("merge3 — three-way line merge", () => {
  it("merges edits to DIFFERENT lines (the whole point)", () => {
    const base = "line1\nline2\nline3\n";
    const a = "LINE1\nline2\nline3\n"; // changed first line
    const b = "line1\nline2\nLINE3\n"; // changed last line
    const r = merge3(base, a, b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "LINE1\nline2\nLINE3\n"); // both changes present
  });

  it("conflicts when both change the SAME line differently", () => {
    const base = "shared\n";
    const a = "alpha's take\n";
    const b = "bravo's take\n";
    const r = merge3(base, a, b);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "conflict");
  });

  it("takes the edited side when the other side left the region unchanged", () => {
    const base = "a\nb\nc\n";
    const a = "a\nb\nc\n"; // unchanged
    const b = "a\nB-EDIT\nc\n"; // only b edited middle
    const r = merge3(base, a, b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "a\nB-EDIT\nc\n");
  });

  it("accepts identical edits from both sides (no false conflict)", () => {
    const base = "x\ny\nz\n";
    const same = "x\nY2\nz\n";
    const r = merge3(base, same, same);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "x\nY2\nz\n");
  });

  it("merges insertions at different positions", () => {
    const base = "header\nbody\nfooter\n";
    const a = "header\nINTRO\nbody\nfooter\n"; // insert after header
    const b = "header\nbody\nfooter\nAPPENDIX\n"; // append at end
    const r = merge3(base, a, b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "header\nINTRO\nbody\nfooter\nAPPENDIX\n");
  });

  it("merges a deletion and an edit separated by an unchanged anchor line", () => {
    // The edited line and the deleted line are separated by an unchanged
    // line ("mid"), so diff3 has an anchor to split the regions and can merge.
    const base = "first\nmid\ndrop\nlast\n";
    const a = "first\nmid\nlast\n"; // deleted "drop"
    const b = "FIRST\nmid\ndrop\nlast\n"; // edited "first"
    const r = merge3(base, a, b);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "FIRST\nmid\nlast\n");
  });

  it("conservatively conflicts when changes are ADJACENT (no separating anchor)", () => {
    // a edits line 1, b deletes the immediately-adjacent line 2. With no
    // unchanged line between them, diff3 can't prove the merge is safe, so it
    // conflicts rather than guess — the data-safe choice (no silent loss).
    const base = "first\ndrop\nlast\n";
    const a = "FIRST\ndrop\nlast\n"; // edit line 1
    const b = "first\nlast\n"; // delete adjacent line 2
    const r = merge3(base, a, b);
    assert.equal(r.ok, false);
  });

  it("conflicts when one side deletes a line the other edits", () => {
    const base = "a\ntarget\nc\n";
    const a = "a\nc\n"; // deleted target
    const b = "a\nTARGET-EDITED\nc\n"; // edited the same target
    const r = merge3(base, a, b);
    assert.equal(r.ok, false);
  });

  it("round-trips byte-exactly with and without a trailing newline", () => {
    // Trailing-newline case: edit line 1, append at end (separated by the
    // unchanged middle lines).
    const r = merge3("one\ntwo\nthree\n", "ONE\ntwo\nthree\n", "one\ntwo\nthree\nfour\n");
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.merged, "ONE\ntwo\nthree\nfour\n");
    // No-trailing-newline case: an unchanged anchor line ("b") separates the
    // two edits, so the merge is safe and the missing final newline is kept.
    const r2 = merge3("a\nb\nc", "A\nb\nc", "a\nb\nC");
    assert.ok(r2.ok);
    if (!r2.ok) return;
    assert.equal(r2.merged, "A\nb\nC");
  });

  it("handles empty base (both sides add content) — conflict if they differ", () => {
    assert.equal(merge3("", "alpha\n", "bravo\n").ok, false);
    // Identical additions merge cleanly.
    const r = merge3("", "same\n", "same\n");
    assert.ok(r.ok);
  });

  it("isMergeableText rejects CRLF and NUL, accepts plain \\n", () => {
    assert.equal(isMergeableText("a\nb\n"), true);
    assert.equal(isMergeableText("a\r\nb\r\n"), false);
    assert.equal(isMergeableText("a\0b"), false);
  });
});
