export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Production env sanity check — warn loudly at startup (never exit) when
    // secrets are missing or the unsandboxed local shell is enabled. These
    // are configuration smells that quietly weaken security in production.
    if (process.env.NODE_ENV === "production") {
      const warnings: string[] = [];
      if (!process.env.A2A_GRANT_SECRET) {
        warnings.push(
          "A2A_GRANT_SECRET is unset — capability grants are signed with a derived dev-fallback secret. Set a 32-byte hex secret.",
        );
      }
      const oauthConfigured = Object.keys(process.env).some((k) =>
        k.startsWith("A2A_OAUTH_"),
      );
      if (!process.env.SESSION_SECRET && oauthConfigured) {
        warnings.push(
          "SESSION_SECRET is unset while an A2A_OAUTH_* provider is configured — OAuth state would be signed with a public fallback literal. Set SESSION_SECRET.",
        );
      }
      if (process.env.A2A_SANDBOX_LOCAL === "1") {
        warnings.push(
          "A2A_SANDBOX_LOCAL=1 — test_command runs execute via UNSANDBOXED bash on this host. Strongly discouraged in production; use VERCEL_SANDBOX_TOKEN instead.",
        );
      }
      if (!process.env.NEXT_PUBLIC_APP_URL) {
        warnings.push(
          "NEXT_PUBLIC_APP_URL is unset — password-reset and email-verification links fall back to http://localhost:3000 and will be unusable for real users. Set it to the public origin.",
        );
      }
      for (const w of warnings) console.error("[env-check]", w);
    }

    const { ensureManagedAgentHooks } = await import("@/lib/managed-agents-init");
    ensureManagedAgentHooks();
    // Resume any pending reply jobs left over from the last process, and
    // tombstone the ones stuck in 'running' so phantom typing indicators
    // don't outlive a server restart.
    const { runPendingJobs, resumeOrphanedJobs } = await import("@/lib/managed-agents");
    resumeOrphanedJobs();
    runPendingJobs(20).catch((err) => {
      console.error("initial runPendingJobs failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });

    // Retention sweep — the single-SQLite-file model has no external cron, so
    // several tables (a2a_idempotency, device_auth_requests, rate_limit_buckets,
    // conversation_events, finished reply_jobs, expired sessions, old audit
    // rows) would grow forever. Run a low-frequency best-effort sweep. Always
    // on (cheap), guarded by env only for tuning the interval; unref'd so it
    // never keeps the process alive.
    if (process.env.A2A_MAINTENANCE_SWEEP !== "0") {
      const { runMaintenanceSweep } = await import("@/lib/maintenance");
      const sweepMs = Math.max(
        15 * 60_000,
        Number(process.env.A2A_MAINTENANCE_SWEEP_MS) || 6 * 3_600_000,
      );
      const sweep = () => {
        try {
          runMaintenanceSweep();
        } catch (err) {
          console.error("maintenance sweep failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };
      sweep(); // once at startup to reclaim whatever piled up while down
      setInterval(sweep, sweepMs).unref?.();
    }

    // Autonomous task tick — what makes a managed agent drive an assigned
    // task toward done with no human nudging each step. Opt-in (the loop
    // spends LLM tokens), guarded, and self-serializing. Interval is wide;
    // each tick processes only actionable assigned/changes_requested tasks.
    if (process.env.A2A_AUTONOMY_TICK === "1") {
      const { tickAutonomousAgents } = await import("@/lib/autonomous");
      const everyMs = Math.max(
        15_000,
        Number(process.env.A2A_AUTONOMY_TICK_MS) || 60_000,
      );
      const tick = () =>
        tickAutonomousAgents().catch((err) => {
          console.error("autonomous tick failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
      // Unref so the interval never keeps the process alive on its own.
      setInterval(tick, everyMs).unref?.();
    }
  }
}
