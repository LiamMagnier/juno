-- CodeWorkspace was added (20260717004000) after the change-capture triggers
-- (20260716200000), so workspace mirror-syncs from the app never surfaced in
-- the account change feed and other devices could not learn about them.
-- Same pattern as every other synced table: userId-owned rows use the
-- 'direct' account resolution.
DROP TRIGGER IF EXISTS juno_change_code_workspace ON "CodeWorkspace";
CREATE TRIGGER juno_change_code_workspace AFTER INSERT OR UPDATE OR DELETE ON "CodeWorkspace" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('code_workspace', 'direct');
