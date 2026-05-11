import "server-only";
import { db } from "./db";

export type SearchHit = {
  message_id: string;
  conversation_id: string;
  from_agent_id: string;
  text: string;
  thinking: string;
  snippet_text: string;
  snippet_thinking: string;
  created_at: number;
};

function escapeFtsTerm(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

export function searchMessagesForUser(
  userId: string,
  query: string,
  limit = 50,
): SearchHit[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeFtsTerm)
    .join(" AND ");
  if (!ftsQuery) return [];

  const ftsHits = db()
    .prepare(
      `SELECT message_id,
              snippet(messages_fts, 2, '<mark>', '</mark>', '…', 12) AS snippet_text,
              snippet(messages_fts, 3, '<mark>', '</mark>', '…', 12) AS snippet_thinking,
              rank
       FROM messages_fts
       WHERE messages_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, limit * 4) as Array<{
    message_id: string;
    snippet_text: string;
    snippet_thinking: string;
    rank: number;
  }>;
  if (ftsHits.length === 0) return [];

  const ids = ftsHits.map((h) => h.message_id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, m.from_agent_id,
              m.text, m.thinking, m.created_at
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
       JOIN agents a ON a.id = cm.agent_id
       WHERE a.owner_user_id = ? AND m.id IN (${placeholders})
       GROUP BY m.id`,
    )
    .all(userId, ...ids) as Array<Omit<SearchHit, "snippet_text" | "snippet_thinking">>;
  const snippetById = Object.fromEntries(
    ftsHits.map((h) => [h.message_id, h]),
  );
  return rows
    .map((r) => ({
      ...r,
      snippet_text: snippetById[r.message_id]?.snippet_text ?? "",
      snippet_thinking: snippetById[r.message_id]?.snippet_thinking ?? "",
    }))
    .sort((a, b) => {
      const ra = snippetById[a.message_id]?.rank ?? 0;
      const rb = snippetById[b.message_id]?.rank ?? 0;
      return ra - rb;
    })
    .slice(0, limit);
}
