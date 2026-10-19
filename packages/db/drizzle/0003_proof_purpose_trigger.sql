-- Postcondition and rollback proofs are distinguished: a verified *rollback* proof must never
-- satisfy the VERIFIED gate, and ROLLED_BACK itself requires a verified rollback proof.
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
    SELECT 1 FROM execution_proofs p WHERE p.action_id = NEW.id AND p.verdict = 'VERIFIED' AND p.purpose = 'postcondition'
  ) THEN
    RAISE EXCEPTION 'FG_STATE: VERIFIED requires an execution proof with verdict VERIFIED' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'ROLLED_BACK' AND NOT EXISTS (
    SELECT 1 FROM execution_proofs p WHERE p.action_id = NEW.id AND p.verdict = 'VERIFIED' AND p.purpose = 'rollback'
  ) THEN
    RAISE EXCEPTION 'FG_STATE: ROLLED_BACK requires a verified rollback proof' USING ERRCODE = 'check_violation';
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
