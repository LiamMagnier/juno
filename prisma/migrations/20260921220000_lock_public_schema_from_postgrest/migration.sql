-- Deny PostgREST the application's tables.
--
-- WHAT WAS WRONG. Supabase runs PostgREST in front of every project and
-- exposes the `public` schema through it, and its default privileges grant ALL
-- on each newly created table to `anon` and `authenticated`. Prisma creates
-- this app's tables in `public`, so all 98 of them were granted — and none of
-- them had row level security, because Prisma does not enable it. The `anon`
-- role is the one an unauthenticated request lands on, and its key is
-- published to browsers by design. Verified on production before this ran:
-- `anon` held SELECT, INSERT, UPDATE, DELETE and TRUNCATE on every table,
-- including User (hashedPassword, totpSecret), Message, Session and
-- NativeRefreshToken, with RLS off on all 98.
--
-- Juno never uses any of that. There is no @supabase/supabase-js in the
-- dependency tree, no PostgREST call, no Supabase Storage: the app reaches
-- this database only as `postgres`, through Prisma, over the Supavisor pooler.
--
-- ENABLE, NOT FORCE. `postgres` owns all 98 tables and carries BYPASSRLS, so
-- ENABLE leaves the application untouched while denying `anon` and
-- `authenticated`, which have neither. FORCE would subject the owner to these
-- policies too, and with no policies defined that would deny the app itself.
-- Do not change this to FORCE without writing policies first.
--
-- Idempotent, so it is safe on a database that has already been locked down by
-- hand.

DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The grants go too. RLS alone already returns nothing, but a policy added
-- later for one table must not silently re-open the other ninety-seven.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

    -- THE ROOT CAUSE, and the reason the two statements above are not enough
    -- on their own: without this, the next migration's new tables arrive
    -- granted to anon all over again.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;

-- `service_role` keeps its grants deliberately: it carries BYPASSRLS, it is
-- never handed to a browser, and Supabase's own tooling authenticates as it.

-- Unrelated to PostgREST, and small: the account-change trigger resolved
-- "User", "Conversation" and "EntityRevision" unqualified under whatever
-- search_path its caller happened to have. `pg_temp` is named LAST on purpose
-- — Postgres searches the temporary schema FIRST unless it appears explicitly,
-- so putting it at the end is what stops a temp table shadowing "User".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'juno_record_account_change'
  ) THEN
    ALTER FUNCTION public.juno_record_account_change() SET search_path = public, pg_temp;
  END IF;
END $$;
