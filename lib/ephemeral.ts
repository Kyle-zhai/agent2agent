import "server-only";

type Entry = { value: string; expires_at: number };

const store = new Map<string, Entry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function gc(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires_at < now) store.delete(k);
  }
}

export function stashSecret(key: string, value: string): void {
  gc();
  store.set(key, { value, expires_at: Date.now() + TTL_MS });
}

export function popSecret(key: string): string | null {
  gc();
  const entry = store.get(key);
  if (!entry) return null;
  store.delete(key);
  return entry.value;
}
