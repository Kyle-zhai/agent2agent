import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET(): Promise<Response> {
  let dbOk = false;
  try {
    db().prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const body = {
    ok: dbOk,
    db: dbOk ? "ok" : "error",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    version: "0.4.0",
  };
  return new Response(JSON.stringify(body), {
    status: dbOk ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
