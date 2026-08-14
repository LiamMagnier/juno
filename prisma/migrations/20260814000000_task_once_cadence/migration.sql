-- One-off scheduled tasks: a fifth cadence that fires at a single local
-- datetime ("onDate" + hour/minute in the task's timezone). The runner
-- disables a ONCE task right after its run, so the row completes rather than
-- recurring. The date is a plain "YYYY-MM-DD" string because, like hour and
-- minute, it names a wall-clock moment whose UTC instant is derived per run.
ALTER TYPE "TaskCadence" ADD VALUE 'ONCE';

ALTER TABLE "ScheduledTask"
  ADD COLUMN "onDate" TEXT;
