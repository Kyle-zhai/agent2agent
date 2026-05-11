export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
  }
}
