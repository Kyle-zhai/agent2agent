/**
 * Vendored line-level three-way merge (diff3). Zero deps — built on the
 * project's own LCS diff (lib/diff.ts), same spirit as the hand-rolled
 * markdown lexer. Used by workspaces.applyPatch to auto-merge two agents'
 * edits to the SAME file when their changes touch DIFFERENT lines, instead
 * of dead-ending every same-file edit at a 409.
 *
 * Algorithm (classic diff3):
 *   1. Find which base lines survive into `a` and into `b` (via LCS).
 *   2. A base line kept in BOTH is a sync anchor. Anchors carve the three
 *      sequences into alternating stable (anchor) and unstable regions.
 *   3. For each unstable region (baseChunk / aChunk / bChunk):
 *        - a unchanged vs base  → take b's version
 *        - b unchanged vs base  → take a's version
 *        - a equals b           → take it (both made the same edit)
 *        - otherwise            → CONFLICT
 *   4. Any conflict ⇒ the whole merge fails (ok:false). We never emit a
 *      partially-merged file with inline markers — a real same-line clash
 *      stays a 409 and goes to the manual /resolve flow, matching the
 *      "surface real conflicts, don't hide them" stance.
 *
 * Line-ending policy: callers must pass pure-\n text (no \r). split/join on
 * "\n" round-trips losslessly for \n text (trailing newline becomes a final
 * "" element and is restored on join), so a successful merge is byte-exact.
 */

import { diffLines } from "./diff";

export type Merge3Result =
  | { ok: true; merged: string }
  | { ok: false; reason: "conflict" | "unmergeable" };

/** Split identically to diffLines so line indices line up. */
function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split(/\r?\n/);
}

/** base-line-index → other-line-index for every line the LCS keeps. Returns
 *  null when the pair can't be diffed (binary / too large). */
function keptMap(baseStr: string, otherStr: string): Map<number, number> | null {
  const d = diffLines(baseStr, otherStr);
  if (!d.ok) return null;
  const m = new Map<number, number>();
  for (const ln of d.lines) {
    if (ln.kind === "equal") m.set(ln.aLine - 1, ln.bLine - 1);
  }
  return m;
}

function arraysEqual(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Three-way merge of pure-\n text. base = common ancestor, a/b = the two
 *  edited versions. */
export function merge3(baseStr: string, aStr: string, bStr: string): Merge3Result {
  const base = splitLines(baseStr);
  const a = splitLines(aStr);
  const b = splitLines(bStr);

  const keptA = keptMap(baseStr, aStr);
  const keptB = keptMap(baseStr, bStr);
  if (!keptA || !keptB) return { ok: false, reason: "unmergeable" };

  // Sync anchors: base lines kept in BOTH a and b. Ascending base order gives
  // ascending a/b indices too (LCS matches are monotonic), so anchors carve
  // all three sequences consistently. A sentinel past the end closes the
  // final region.
  type Anchor = { base: number; a: number; b: number };
  const anchors: Anchor[] = [];
  for (let i = 0; i < base.length; i++) {
    if (keptA.has(i) && keptB.has(i)) {
      anchors.push({ base: i, a: keptA.get(i)!, b: keptB.get(i)! });
    }
  }
  anchors.push({ base: base.length, a: a.length, b: b.length });

  const merged: string[] = [];
  let pb = 0;
  let pa = 0;
  let pbb = 0;
  for (const anc of anchors) {
    const baseChunk = base.slice(pb, anc.base);
    const aChunk = a.slice(pa, anc.a);
    const bChunk = b.slice(pbb, anc.b);

    if (baseChunk.length || aChunk.length || bChunk.length) {
      if (arraysEqual(aChunk, baseChunk)) {
        merged.push(...bChunk); // only b changed this region
      } else if (arraysEqual(bChunk, baseChunk)) {
        merged.push(...aChunk); // only a changed this region
      } else if (arraysEqual(aChunk, bChunk)) {
        merged.push(...aChunk); // both made the identical change
      } else {
        return { ok: false, reason: "conflict" }; // genuine overlap → 409
      }
    }

    if (anc.base < base.length) {
      merged.push(base[anc.base]); // the stable anchor line itself
    }
    pb = anc.base + 1;
    pa = anc.a + 1;
    pbb = anc.b + 1;
  }

  return { ok: true, merged: merged.join("\n") };
}

/** Guard for the caller: only attempt a merge on pure-\n, non-binary text.
 *  CRLF or NUL-bearing content falls back to a hard conflict (409). */
export function isMergeableText(s: string): boolean {
  return !s.includes("\0") && !s.includes("\r");
}
