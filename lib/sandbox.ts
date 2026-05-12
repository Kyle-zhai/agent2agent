import "server-only";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "./db";
import { newSandboxRunId } from "./ids";
import { logAudit } from "./audit";
import { getSnapshot, listFiles, getBlob } from "./workspaces";

// -------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------

export type SandboxRequest = {
  cmd: string;
  shell?: "bash" | "sh";
  snapshot_id: string | null;
  task_id: string;
  initiated_by_agent_id: string;
  timeout_ms?: number;
};

export type SandboxResult = {
  id: string;
  runtime: "vercel" | "local" | "skipped";
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  reason?: string;
};

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;

// -------------------------------------------------------------------------
// Runtime selection
// -------------------------------------------------------------------------

function pickRuntime(): "vercel" | "local" | "none" {
  if (process.env.VERCEL_SANDBOX_TOKEN) return "vercel";
  if (process.env.A2A_SANDBOX_DISABLE === "1") return "none";
  // Local fallback is intentionally available in dev / self-host so the
  // success_criteria.test_command flow can be demoed end-to-end. It is
  // NOT a real isolation boundary; production deployments should set
  // VERCEL_SANDBOX_TOKEN and never reach this branch.
  return "local";
}

// -------------------------------------------------------------------------
// Top-level entry — persists to sandbox_runs + audits
// -------------------------------------------------------------------------

export async function runSandbox(req: SandboxRequest): Promise<SandboxResult> {
  const id = newSandboxRunId();
  const startedAt = Date.now();
  const runtime = pickRuntime();

  db()
    .prepare(
      `INSERT INTO sandbox_runs
       (id, task_id, snapshot_id, initiated_by_agent_id, cmd, shell, runtime,
        exit_code, stdout, stderr, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', '', ?, NULL)`,
    )
    .run(
      id,
      req.task_id,
      req.snapshot_id,
      req.initiated_by_agent_id,
      req.cmd,
      req.shell ?? "bash",
      runtime === "none" ? "skipped" : runtime,
      startedAt,
    );

  let result: SandboxResult;
  try {
    if (runtime === "vercel") {
      result = await runOnVercelSandbox(id, req);
    } else if (runtime === "local") {
      result = await runOnLocalChildProcess(id, req);
    } else {
      result = {
        id,
        runtime: "skipped",
        stdout: "",
        stderr: "",
        exit_code: null,
        duration_ms: 0,
        reason: "A2A_SANDBOX_DISABLE=1 — runs disabled in this deployment.",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      id,
      runtime: runtime === "vercel" ? "vercel" : "local",
      stdout: "",
      stderr: msg,
      exit_code: -1,
      duration_ms: Date.now() - startedAt,
      reason: "internal_error",
    };
    logAudit("sandbox.run_failed", {
      agentId: req.initiated_by_agent_id,
      detail: { run_id: id, task_id: req.task_id, err: msg },
    });
  }

  const finishedAt = Date.now();
  db()
    .prepare(
      `UPDATE sandbox_runs SET exit_code = ?, stdout = ?, stderr = ?,
                                finished_at = ? WHERE id = ?`,
    )
    .run(
      result.exit_code,
      truncate(result.stdout),
      truncate(result.stderr),
      finishedAt,
      id,
    );

  logAudit("sandbox.run", {
    agentId: req.initiated_by_agent_id,
    detail: {
      run_id: id,
      task_id: req.task_id,
      runtime: result.runtime,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
    },
  });
  return result;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + `\n[…truncated ${s.length - MAX_OUTPUT_BYTES} bytes…]`;
}

// -------------------------------------------------------------------------
// Local child_process — dev / self-host fallback
// -------------------------------------------------------------------------

async function runOnLocalChildProcess(
  id: string,
  req: SandboxRequest,
): Promise<SandboxResult> {
  const startedAt = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), `a2a-sbx-${id}-`));
  try {
    if (req.snapshot_id) {
      materializeSnapshot(req.snapshot_id, tmp);
    }
    const shell = req.shell ?? "bash";
    const timeout = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const { stdout, stderr, exit_code } = await spawnAndCapture(
      shell,
      req.cmd,
      tmp,
      timeout,
    );
    return {
      id,
      runtime: "local",
      stdout,
      stderr,
      exit_code,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      console.warn("sandbox cleanup failed", {
        path: tmp,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function materializeSnapshot(snapshotId: string, dir: string): void {
  const snap = getSnapshot(snapshotId);
  if (!snap) throw new Error("snapshot not found");
  const files = listFiles(snap.id);
  for (const f of files) {
    const fullPath = join(dir, f.path);
    const fileDir = dirname(fullPath);
    mkdirSync(fileDir, { recursive: true });
    const content = getBlob(f.content_sha256);
    writeFileSync(fullPath, content);
  }
}

function spawnAndCapture(
  shell: "bash" | "sh",
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exit_code: number | null }> {
  return new Promise((resolve) => {
    // Minimal env — explicitly do NOT pass A2A_* tokens.
    // We cast to NodeJS.ProcessEnv because Next.js augments it with required
    // app-specific keys; our sandboxed child doesn't need them.
    const env = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      TMPDIR: cwd,
      LANG: "C.UTF-8",
    } as unknown as NodeJS.ProcessEnv;
    const child = spawn(shell, ["-c", cmd], {
      cwd,
      env,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, exit_code: -1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exit_code: code });
    });
  });
}

// -------------------------------------------------------------------------
// Vercel Sandbox — preferred for production
// -------------------------------------------------------------------------

async function runOnVercelSandbox(
  id: string,
  req: SandboxRequest,
): Promise<SandboxResult> {
  const startedAt = Date.now();
  const token = process.env.VERCEL_SANDBOX_TOKEN!;
  const endpoint =
    process.env.VERCEL_SANDBOX_ENDPOINT ?? "https://sandbox.vercel.com/v1/runs";

  // Pack the snapshot file tree into the request. The Vercel Sandbox API
  // accepts a "files" map of { path: base64 } plus a "cmd". We use POST.
  const files: Record<string, string> = {};
  if (req.snapshot_id) {
    const snap = getSnapshot(req.snapshot_id);
    if (!snap) throw new Error("snapshot not found");
    for (const f of listFiles(snap.id)) {
      files[f.path] = getBlob(f.content_sha256).toString("base64");
    }
  }

  const body = {
    cmd: req.cmd,
    shell: req.shell ?? "bash",
    files,
    timeout_ms: req.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    image: process.env.VERCEL_SANDBOX_IMAGE ?? "node:24-bookworm",
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return {
      id,
      runtime: "vercel",
      stdout: "",
      stderr: `vercel sandbox ${resp.status}: ${txt.slice(0, 1000)}`,
      exit_code: -1,
      duration_ms: Date.now() - startedAt,
      reason: "vercel_http_error",
    };
  }
  const json = (await resp.json()) as {
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
  };
  return {
    id,
    runtime: "vercel",
    stdout: typeof json.stdout === "string" ? json.stdout : "",
    stderr: typeof json.stderr === "string" ? json.stderr : "",
    exit_code: typeof json.exit_code === "number" ? json.exit_code : null,
    duration_ms: Date.now() - startedAt,
  };
}

// -------------------------------------------------------------------------
// Listing
// -------------------------------------------------------------------------

export function listSandboxRunsForTask(
  taskId: string,
): Array<{
  id: string;
  cmd: string;
  runtime: string;
  exit_code: number | null;
  duration_ms: number | null;
  stdout: string;
  stderr: string;
  started_at: number;
  finished_at: number | null;
}> {
  return db()
    .prepare(
      `SELECT id, cmd, runtime, exit_code,
              (finished_at - started_at) AS duration_ms,
              stdout, stderr, started_at, finished_at
       FROM sandbox_runs WHERE task_id = ?
       ORDER BY started_at ASC`,
    )
    .all(taskId) as Array<{
    id: string;
    cmd: string;
    runtime: string;
    exit_code: number | null;
    duration_ms: number | null;
    stdout: string;
    stderr: string;
    started_at: number;
    finished_at: number | null;
  }>;
}
