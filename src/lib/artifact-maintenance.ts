/** Bounded artifact sweeps hosted by the existing scheduler, sharing its pool. */
export function createArtifactMaintenance({ seal, purge, report }: {
  seal: () => Promise<number>;
  purge: () => Promise<{ eligible: number; purged: number; dryRun: boolean }>;
  report: (message: string, details: Record<string, unknown>) => void;
}): (nowMs: number) => Promise<void> {
  let nextSealAt = 0;
  let nextPurgeAt = 0;
  return async (nowMs) => {
    if (nowMs >= nextSealAt) {
      nextSealAt = nowMs + 60_000;
      try {
        const sealed = await seal();
        if (sealed > 0) report("artifact drafts sealed", { sealed });
      } catch (error) {
        report("artifact draft sweep failed", { error: String(error) });
      }
    }
    if (nowMs >= nextPurgeAt) {
      nextPurgeAt = nowMs + 6 * 60 * 60_000;
      try {
        report("artifact trash sweep", { ...await purge() });
      } catch (error) {
        report("artifact trash sweep failed", { error: String(error) });
      }
    }
  };
}
