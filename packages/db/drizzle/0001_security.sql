-- FUTUREGROW security migration (D-008, D-009, D-011, M24 immutable audit).
-- Idempotent where practical. Reference data (allowed transitions) and per-table RLS/grants are
-- (re)applied by fg_apply_security(), which the migrate CLI calls after every migration run.

-- 1. Tenant role used for every tenant-scoped transaction (SET LOCAL ROLE fg_tenant).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fg_tenant') THEN
    BEGIN
      CREATE ROLE fg_tenant NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'fg_tenant role could not be created (insufficient privilege); see BLOCKERS B-004';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fg_tenant') THEN
    BEGIN
      EXECUTE format('GRANT fg_tenant TO %I', current_user);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'could not grant fg_tenant to %: %', current_user, SQLERRM;
    END;
  END IF;
END $$;
--> statement-breakpoint

-- 2. Allowed action-state transitions (synced from @futuregrow/contracts by the migrate CLI).
CREATE TABLE IF NOT EXISTS action_state_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
--> statement-breakpoint

-- 3. Tables that are global (no tenant_id) but readable by tenants.
CREATE TABLE IF NOT EXISTS fg_security_config (
  table_name text PRIMARY KEY,
  tenant_privileges text NOT NULL
);
--> statement-breakpoint

INSERT INTO fg_security_config (table_name, tenant_privileges) VALUES
  ('platform_capabilities', 'SELECT'),
  ('model_registry', 'SELECT'),
  ('jurisdiction_rules', 'SELECT'),
  ('system_controls', 'SELECT'),
  ('action_state_transitions', 'SELECT'),
  -- append-only tenant tables (no UPDATE/DELETE for the tenant role)
  ('audit_log', 'SELECT, INSERT'),
  ('action_transitions', 'SELECT, INSERT'),
  ('outbox_events', 'SELECT, INSERT'),
  ('approvals', 'SELECT, INSERT'),
  ('execution_proofs', 'SELECT, INSERT'),
  ('consent_events', 'SELECT, INSERT'),
  ('spend_ledger', 'SELECT, INSERT'),
  ('commission_ledger', 'SELECT, INSERT'),
  ('identity_merges', 'SELECT, INSERT')
ON CONFLICT (table_name) DO UPDATE SET tenant_privileges = EXCLUDED.tenant_privileges;
--> statement-breakpoint

-- 4. Apply RLS + grants to every table that has a tenant_id column.
CREATE OR REPLACE FUNCTION fg_apply_security() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  privs text;
  has_role boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fg_tenant');
BEGIN
  IF NOT has_role THEN
    RAISE WARNING 'fg_tenant role missing; RLS policies not applied (B-004)';
  ELSE
    EXECUTE 'GRANT USAGE ON SCHEMA public TO fg_tenant';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fg_tenant';
  END IF;

  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    IF has_role THEN
      EXECUTE format('DROP POLICY IF EXISTS fg_tenant_isolation ON %I', r.table_name);
      EXECUTE format(
        'CREATE POLICY fg_tenant_isolation ON %I AS PERMISSIVE FOR ALL TO fg_tenant '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
        r.table_name);
      SELECT tenant_privileges INTO privs FROM fg_security_config WHERE table_name = r.table_name;
      EXECUTE format('REVOKE ALL ON %I FROM fg_tenant', r.table_name);
      EXECUTE format('GRANT %s ON %I TO fg_tenant', COALESCE(privs, 'SELECT, INSERT, UPDATE, DELETE'), r.table_name);
    END IF;
  END LOOP;

  IF has_role THEN
    FOR r IN
      SELECT s.table_name, s.tenant_privileges FROM fg_security_config s
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = s.table_name AND c.column_name = 'tenant_id')
      AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_name = s.table_name)
    LOOP
      EXECUTE format('REVOKE ALL ON %I FROM fg_tenant', r.table_name);
      EXECUTE format('GRANT %s ON %I TO fg_tenant', r.tenant_privileges, r.table_name);
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint

-- 5. Append-only enforcement (applies to every role, including the owner).
CREATE OR REPLACE FUNCTION fg_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FG_IMMUTABLE: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log', 'action_transitions', 'approvals', 'execution_proofs', 'consent_events', 'spend_ledger', 'commission_ledger', 'identity_merges']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fg_immutable_row ON %I', t);
    EXECUTE format('CREATE TRIGGER fg_immutable_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fg_forbid_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS fg_immutable_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER fg_immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fg_forbid_mutation()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 6. Execution state machine (D-011): legal transitions only; VERIFIED requires a VERIFIED proof.
CREATE OR REPLACE FUNCTION fg_action_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'FG_STATE: action requests must be created in PROPOSED, got %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.action_hash <> OLD.action_hash OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.target IS DISTINCT FROM OLD.target OR NEW.action_type <> OLD.action_type THEN
    RAISE EXCEPTION 'FG_STATE: action payload is immutable after proposal' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM action_state_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'FG_STATE: illegal transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'VERIFIED' AND NOT EXISTS (
    SELECT 1 FROM execution_proofs p WHERE p.action_id = NEW.id AND p.verdict = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'FG_STATE: VERIFIED requires an execution proof with verdict VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status = 'APPROVAL_REQUIRED' AND NOT EXISTS (
    SELECT 1 FROM approvals a WHERE a.action_id = NEW.id AND a.decision = 'approved' AND a.action_hash = NEW.action_hash
  ) THEN
    RAISE EXCEPTION 'FG_STATE: APPROVED requires an approval bound to the action hash' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO action_transitions (tenant_id, action_id, from_status, to_status, reason, actor)
  VALUES (NEW.tenant_id, NEW.id, OLD.status, NEW.status,
          NULLIF(current_setting('app.transition_reason', true), ''),
          COALESCE(NULLIF(current_setting('app.actor', true), ''), 'unknown'));
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fg_action_state_guard ON action_requests;
--> statement-breakpoint
CREATE TRIGGER fg_action_state_guard BEFORE INSERT OR UPDATE ON action_requests
  FOR EACH ROW EXECUTE FUNCTION fg_action_state_guard();
--> statement-breakpoint

-- 7. Transactional outbox -> Graphile Worker job, atomically in the same transaction (D-009).
CREATE OR REPLACE FUNCTION fg_outbox_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'dispatch_event',
    json_build_object('eventId', NEW.id, 'tenantId', NEW.tenant_id, 'eventType', NEW.event_type),
    job_key => 'evt:' || NEW.id::text,
    max_attempts => 25::smallint
  );
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fg_outbox_enqueue ON outbox_events;
--> statement-breakpoint
CREATE TRIGGER fg_outbox_enqueue AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION fg_outbox_enqueue();
--> statement-breakpoint

-- Allow the worker (owner) to mark events dispatched without opening UPDATE to tenants.
-- (outbox_events is SELECT/INSERT only for fg_tenant via fg_security_config.)

-- 8. Experiments: assignment before exposure, exposure before outcome (M10 AC).
CREATE OR REPLACE FUNCTION fg_experiment_exposure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM experiment_assignments a
    WHERE a.experiment_id = NEW.experiment_id AND a.unit_id = NEW.unit_id AND a.variant_id = NEW.variant_id
      AND a.assigned_at <= NEW.exposed_at
  ) THEN
    RAISE EXCEPTION 'FG_EXPERIMENT: exposure without a prior matching assignment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fg_experiment_exposure_guard ON experiment_exposures;
--> statement-breakpoint
CREATE TRIGGER fg_experiment_exposure_guard BEFORE INSERT ON experiment_exposures
  FOR EACH ROW EXECUTE FUNCTION fg_experiment_exposure_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fg_experiment_outcome_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM experiment_exposures e
    WHERE e.experiment_id = NEW.experiment_id AND e.unit_id = NEW.unit_id AND e.variant_id = NEW.variant_id
      AND e.exposed_at <= NEW.observed_at
  ) THEN
    RAISE EXCEPTION 'FG_EXPERIMENT: outcome without a prior logged exposure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fg_experiment_outcome_guard ON experiment_outcomes;
--> statement-breakpoint
CREATE TRIGGER fg_experiment_outcome_guard BEFORE INSERT ON experiment_outcomes
  FOR EACH ROW EXECUTE FUNCTION fg_experiment_outcome_guard();
--> statement-breakpoint

-- 9. Evidence content is immutable; the only permitted change is erasure to NULL (DSAR).
CREATE OR REPLACE FUNCTION fg_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_sha256 <> OLD.content_sha256
     OR (NEW.content IS NOT NULL AND NEW.content IS DISTINCT FROM OLD.content)
     OR (NEW.content_object_key IS NOT NULL AND NEW.content_object_key IS DISTINCT FROM OLD.content_object_key)
     OR NEW.retrieved_at <> OLD.retrieved_at
     OR NEW.source_uri_or_object_id <> OLD.source_uri_or_object_id
     OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'FG_IMMUTABLE: evidence content/provenance cannot be modified' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS fg_evidence_guard ON evidence_records;
--> statement-breakpoint
CREATE TRIGGER fg_evidence_guard BEFORE UPDATE ON evidence_records
  FOR EACH ROW EXECUTE FUNCTION fg_evidence_guard();
--> statement-breakpoint

SELECT fg_apply_security();
