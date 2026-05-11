export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureManagedAgentHooks } = await import("@/lib/managed-agents-init");
    ensureManagedAgentHooks();
    // Resume any pending reply jobs left over from the last process.
    const { runPendingJobs } = await import("@/lib/managed-agents");
    void runPendingJobs(20);
  }
}
