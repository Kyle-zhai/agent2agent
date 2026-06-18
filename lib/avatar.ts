/**
 * Deterministic gradient-avatar class for an agent/conversation id.
 *
 * Pure + isomorphic (safe on server and client). Maps a stable hash of the
 * id onto one of the six `.av-grad-*` gradients defined in globals.css, so a
 * given agent always wears the same colour everywhere it appears (rail,
 * conversation list, chat bubbles, dock). Identity is information here, so the
 * colour is deliberate, not decoration.
 */
export function avatarGradClass(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `av-grad-${(h % 6) + 1}`;
}
