-- paperclip:migration-compat online_compatible: the replacement privacy-source trigger is a strict improvement over the one the previous release installed: it only ever removes already-deleted task keys from provenance metadata, so every write the previous release can make still satisfies the new function; each rewrite is a per-row keyset batch over the primary key with commits between batches and the executor runs this file outside a file transaction, so no long lock is held; deletion and live-unreadable sources keep denying through the same predicate the previous release reads.
CREATE OR REPLACE FUNCTION retain_workspace_privacy_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sources jsonb := '{}'::jsonb; linked jsonb; key text; live jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.metadata->'_issuePrivacySources') = 'object' THEN
    sources := OLD.metadata->'_issuePrivacySources';
  END IF;
  IF NEW.source_issue_id IS NOT NULL THEN
    sources := sources || jsonb_build_object(NEW.source_issue_id::text, true);
  END IF;
  SELECT jsonb_object_agg(id::text, true) INTO linked FROM issues
    WHERE execution_workspace_id = NEW.id AND company_id = NEW.company_id;
  sources := sources || coalesce(linked, '{}'::jsonb);
  -- Deleted tasks carry no policy to evaluate: keep live provenance only so a
  -- removed task cannot leave a workspace permanently unreadable.
  FOR key IN SELECT jsonb_object_keys(sources) LOOP
    IF key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (SELECT 1 FROM issues WHERE id = key::uuid AND company_id = NEW.company_id) THEN
      live := live || jsonb_build_object(key, true);
    END IF;
  END LOOP;
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('_issuePrivacySources', live);
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TRIGGER IF EXISTS execution_workspaces_privacy_sources ON execution_workspaces;
  CREATE TRIGGER execution_workspaces_privacy_sources BEFORE INSERT OR UPDATE OF source_issue_id, metadata
    ON execution_workspaces FOR EACH ROW EXECUTE FUNCTION retain_workspace_privacy_sources();
END $$;
--> statement-breakpoint
-- Deleting a task strips its key from every workspace it once fed, inside the
-- deleting statement's transaction, so readers never observe a stale key.
CREATE OR REPLACE FUNCTION strip_deleted_issue_privacy_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE execution_workspaces SET metadata = metadata
    WHERE company_id = OLD.company_id
      AND (source_issue_id IS NULL OR source_issue_id <> OLD.id)
      AND metadata->'_issuePrivacySources' ? OLD.id::text;
  RETURN OLD;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TRIGGER IF EXISTS issues_strip_workspace_privacy_sources ON issues;
  CREATE TRIGGER issues_strip_workspace_privacy_sources AFTER DELETE
    ON issues FOR EACH ROW EXECUTE FUNCTION strip_deleted_issue_privacy_sources();
END $$;
--> statement-breakpoint
-- Sanitize workspaces that already hold keys of hard-deleted tasks. Keyset
-- batches over the primary key commit between batches (executor runs this
-- file outside a transaction); visited rows stop matching the predicate, so
-- the loop always advances.
DO $$ DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; next_id uuid;
BEGIN LOOP
  WITH batch AS MATERIALIZED (SELECT id FROM execution_workspaces
      WHERE id > cursor_id AND metadata->'_issuePrivacySources' ?| ARRAY(
        SELECT key FROM jsonb_object_keys(coalesce(metadata->'_issuePrivacySources', '{}'::jsonb)) AS k(key)
        WHERE NOT EXISTS (SELECT 1 FROM issues WHERE id = NULLIF(key, '')::uuid AND company_id = execution_workspaces.company_id))
      ORDER BY id LIMIT 1000),
  changed AS (UPDATE execution_workspaces w SET metadata = metadata FROM batch b WHERE w.id = b.id RETURNING w.id)
  SELECT id INTO next_id FROM changed ORDER BY id DESC LIMIT 1;
  EXIT WHEN next_id IS NULL;
  cursor_id := next_id;
  COMMIT;
END LOOP; END $$;
