-- Arms change capture for Juno Work.
--
-- ============================================================================
-- RELEASE ORDER IS A HARD PREREQUISITE, NOT A NOTE. DO NOT APPLY THIS FILE
-- UNTIL A BUILD CARRYING THE TWELVE ENTITY-TYPE STRINGS BELOW IS THE OLDEST
-- CLIENT IN THE FIELD.
--
-- `NativeSyncAPIClient.requireEntityType` THROWS on an entity type it does not
-- know, and that aborts the whole page rather than skipping one row — so a type
-- the server has started emitting and a client has not learned does not degrade
-- gracefully, it stops that account syncing entirely, on that device, for
-- everything. Unlike `project_workspace`, which could be added ahead of its
-- writer because the table was empty, every Work table already has rows on
-- live accounts: the first Work write after this migration lands emits a
-- change, and every installed client that predates the strings is finished.
--
-- The two allowlists that must ship first:
--   native/Packages/JunoNativeKit/Sources/JunoSync/NativeSyncAPIClient.swift
--   native/desktop-electron/src/main/sync/types.ts
--
-- Both need: work_session, work_run, work_approval, work_artifact,
-- work_artifact_version, work_host, work_file_grant, work_session_connector,
-- work_skill, work_skill_version, work_schedule, work_trigger.
-- ============================================================================
--
-- The type strings are the TG_ARGV[0] values below and must match the loader
-- keys in src/lib/sync-entities.ts exactly — that pairing is what a client reads
-- back from /api/v1/changes and then hydrates from /api/v1/entities. A trigger
-- with no loader emits a change nothing can resolve; a loader with no trigger is
-- the state Work was already in, and is why none of this could reach a device.
--
-- Four Work models are deliberately absent, matching the loader file:
-- WorkEvent (its own SSE transport with a per-run seq cursor; a row per
-- token-step here would swamp the account feed), WorkCommand (relay control
-- plane — leased, host-addressed, and a replayed command is an action taken
-- twice), WorkRunIO (provenance meaningful only beside the artifact version it
-- points at) and WorkAuditEvent (the security log, which deliberately outlives
-- the session it describes).

BEGIN;

DROP TRIGGER IF EXISTS juno_change_work_session ON "WorkSession";
DROP TRIGGER IF EXISTS juno_change_work_run ON "WorkRun";
DROP TRIGGER IF EXISTS juno_change_work_approval ON "WorkApproval";
DROP TRIGGER IF EXISTS juno_change_work_artifact ON "WorkArtifact";
DROP TRIGGER IF EXISTS juno_change_work_artifact_version ON "WorkArtifactVersion";
DROP TRIGGER IF EXISTS juno_change_work_host ON "WorkHost";
DROP TRIGGER IF EXISTS juno_change_work_file_grant ON "WorkFileGrant";
DROP TRIGGER IF EXISTS juno_change_work_session_connector ON "WorkSessionConnector";
DROP TRIGGER IF EXISTS juno_change_work_skill ON "WorkSkill";
DROP TRIGGER IF EXISTS juno_change_work_skill_version ON "WorkSkillVersion";
DROP TRIGGER IF EXISTS juno_change_work_schedule ON "WorkSchedule";
DROP TRIGGER IF EXISTS juno_change_work_trigger ON "WorkTrigger";

-- Owner-column rows. `work_run`, `work_artifact` and `work_session_connector`
-- use 'work_session' rather than 'direct' only to record the parent pointer —
-- the account still comes from their own userId column.
CREATE TRIGGER juno_change_work_session AFTER INSERT OR UPDATE OR DELETE ON "WorkSession" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_session', 'direct');
CREATE TRIGGER juno_change_work_run AFTER INSERT OR UPDATE OR DELETE ON "WorkRun" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_run', 'work_session');
CREATE TRIGGER juno_change_work_approval AFTER INSERT OR UPDATE OR DELETE ON "WorkApproval" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_approval', 'work_run');
CREATE TRIGGER juno_change_work_artifact AFTER INSERT OR UPDATE OR DELETE ON "WorkArtifact" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_artifact', 'work_session');
CREATE TRIGGER juno_change_work_host AFTER INSERT OR UPDATE OR DELETE ON "WorkHost" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_host', 'direct');
CREATE TRIGGER juno_change_work_file_grant AFTER INSERT OR UPDATE OR DELETE ON "WorkFileGrant" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_file_grant', 'direct');
CREATE TRIGGER juno_change_work_session_connector AFTER INSERT OR UPDATE OR DELETE ON "WorkSessionConnector" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_session_connector', 'work_session');
CREATE TRIGGER juno_change_work_skill AFTER INSERT OR UPDATE OR DELETE ON "WorkSkill" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_skill', 'direct');
CREATE TRIGGER juno_change_work_schedule AFTER INSERT OR UPDATE OR DELETE ON "WorkSchedule" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_schedule', 'direct');
CREATE TRIGGER juno_change_work_trigger AFTER INSERT OR UPDATE OR DELETE ON "WorkTrigger" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_trigger', 'work_schedule');

-- Version rows carry no owner column at all; these two resolve through their
-- head row, and through the revision fallback when the head has already been
-- cascaded away.
CREATE TRIGGER juno_change_work_artifact_version AFTER INSERT OR UPDATE OR DELETE ON "WorkArtifactVersion" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_artifact_version', 'work_artifact');
CREATE TRIGGER juno_change_work_skill_version AFTER INSERT OR UPDATE OR DELETE ON "WorkSkillVersion" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('work_skill_version', 'work_skill');

COMMIT;

-- No backfill.
--
-- The obvious next step is an INSERT ... SELECT that gives every existing Work
-- row a revision, and it is deliberately not here. A backfill writes one
-- AccountChange per row, so it would hand every device an account-sized page of
-- changes at whatever moment it ran — and this repo has already shipped one
-- backfill migration whose bare NULL failed in production, which is the reason
-- the rule about explicit types exists.
--
-- The cost of leaving it out is real and should be stated rather than implied:
-- `listEntityIndex` enumerates EntityRevision, so a Work row that has never been
-- written again after this migration has no revision, is not in the index, and
-- a freshly installed client will not discover it. Work rows are written on
-- every status change, so live tasks self-heal within one run; a task that
-- finished last month does not. Closing that needs a batched, rate-limited
-- backfill in a script that can be paused and resumed — which is the shape a
-- migration cannot take, since it holds one transaction and cannot be watched.
