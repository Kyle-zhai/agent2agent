// Initialize (or migrate) the SQLite schema by reusing lib/db.ts as the
// single source of truth — calling db() runs init() + migrate() on the file
// at A2A_DB_PATH (default ./data/a2a.db). Run via tsx with the test tsconfig
// so the `server-only` import resolves to a no-op shim outside Next.js:
//   TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx scripts/db-init.ts
import { db } from "../lib/db";

const d = db();
const tables = (
  d
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
    .get() as { n: number }
).n;
console.log(
  `✓ schema ready (${tables} tables) at ${process.env.A2A_DB_PATH ?? "data/a2a.db"}`,
);
