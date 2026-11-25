-- How an organization pays for machines: 'resold' (our provider account, our margin, our
-- invoices) or 'byok' (its own provider account: the provider bills it, our ledger runs at
-- margin 0 as a budget). There is no default: every org states its mode when it's created,
-- and nothing unset or unknown ever resolves to our account. Existing orgs are resold.
-- The mode is fixed once set; changing it is a later, supervised step.

ALTER TABLE orgs ADD COLUMN billing_mode TEXT CHECK (billing_mode IN ('resold', 'byok'));
UPDATE orgs SET billing_mode = 'resold';

CREATE TRIGGER orgs_billing_mode_stated BEFORE INSERT ON orgs
WHEN NEW.billing_mode IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an organization states its billing mode');
END;

CREATE TRIGGER orgs_billing_mode_fixed BEFORE UPDATE OF billing_mode ON orgs
WHEN NEW.billing_mode IS NOT OLD.billing_mode
BEGIN
  SELECT RAISE(ABORT, 'an organization''s billing mode is fixed');
END;

-- Nothing crosses between billing modes: a project moves only between organizations of the
-- same mode, and a machine only between projects whose organizations share it (whatever the
-- margins or accruals; a supervised transfer is a later step).
CREATE TRIGGER projects_billing_mode_move BEFORE UPDATE OF org_id ON projects
WHEN NEW.org_id IS NOT OLD.org_id
  AND (SELECT billing_mode FROM orgs WHERE id = NEW.org_id) IS NOT (SELECT billing_mode FROM orgs WHERE id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'a project moves only between organizations of the same billing mode');
END;

CREATE TRIGGER machines_billing_mode_move BEFORE UPDATE OF project_id ON machines
WHEN NEW.project_id IS NOT OLD.project_id
  AND (SELECT o.billing_mode FROM projects p JOIN orgs o ON o.id = p.org_id WHERE p.id = NEW.project_id)
    IS NOT (SELECT o.billing_mode FROM projects p JOIN orgs o ON o.id = p.org_id WHERE p.id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'a machine moves only between projects of the same billing mode');
END;

-- byok runs at margin 0: the org's margin, its projects' overrides and every pinned accrual
CREATE TRIGGER orgs_byok_margin_insert BEFORE INSERT ON orgs
WHEN NEW.billing_mode IS 'byok' AND NEW.margin_bps <> 0
BEGIN
  SELECT RAISE(ABORT, 'a byok organization has margin 0');
END;

CREATE TRIGGER orgs_byok_margin_update BEFORE UPDATE OF margin_bps ON orgs
WHEN NEW.billing_mode IS 'byok' AND NEW.margin_bps <> 0
BEGIN
  SELECT RAISE(ABORT, 'a byok organization has margin 0');
END;

CREATE TRIGGER projects_byok_margin_insert BEFORE INSERT ON projects
WHEN COALESCE(NEW.margin_bps_override, 0) <> 0 AND (SELECT billing_mode FROM orgs WHERE id = NEW.org_id) IS NOT 'resold'
BEGIN
  SELECT RAISE(ABORT, 'only a resold organization''s projects have a margin');
END;

CREATE TRIGGER projects_byok_margin_update BEFORE UPDATE OF margin_bps_override ON projects
WHEN COALESCE(NEW.margin_bps_override, 0) <> 0 AND (SELECT billing_mode FROM orgs WHERE id = NEW.org_id) IS NOT 'resold'
BEGIN
  SELECT RAISE(ABORT, 'only a resold organization''s projects have a margin');
END;

CREATE TRIGGER machine_accruals_byok_margin BEFORE INSERT ON machine_accruals
WHEN NEW.margin_bps <> 0 AND (
  SELECT o.billing_mode FROM machines m JOIN projects p ON p.id = m.project_id JOIN orgs o ON o.id = p.org_id
  WHERE m.id = NEW.machine_id
) IS NOT 'resold'
BEGIN
  SELECT RAISE(ABORT, 'only a resold organization''s machines accrue a margin');
END;
