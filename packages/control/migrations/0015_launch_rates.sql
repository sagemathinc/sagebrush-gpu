-- A launch's pinned rate (the container-launch design r2.1, step 3; SEC ruling on the
-- pinned-rate gap): the offer's provider cost per hour and the margin, written in the same
-- batch as the launch intent, before any create. The machine's accrual is opened from it,
-- whether the create's reply arrived or the watchdog found the machine after a lost reply or a
-- crash: the rate a launch bills at never lives only in the memory of the request that created
-- it, and a create that definitively failed leaves this record and no accrual. The provider is
-- the launch's own (no second copy that could diverge).
--
-- Enforced here:
-- - a rate is written only for an existing launch that is still creating (either mode); it is
--   never changed or deleted;
-- - a container launch takes its provider id, or leaves creating, only with its rate (VM
--   launches are unchanged here: the VM orchestrator brings its own rules);
-- - an accrual of a launch that has a rate, or of a container launch, is exactly that rate:
--   the launch's provider, the rate's cost and margin; for a container, the launch's intent
--   time as its start. A missing launch or rate aborts it; nothing passes for want of a row.

CREATE TABLE launch_rates (
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  provider_cost_per_hour INTEGER NOT NULL CHECK (provider_cost_per_hour BETWEEN 0 AND 9007199254740991),
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  PRIMARY KEY (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation) REFERENCES launches (machine_id, incarnation)
) STRICT;

CREATE TRIGGER launch_rates_for_intent BEFORE INSERT ON launch_rates
WHEN NOT EXISTS (
  SELECT 1 FROM launches l
  WHERE l.machine_id = NEW.machine_id AND l.incarnation = NEW.incarnation AND l.outcome = 'creating'
)
BEGIN
  SELECT RAISE(ABORT, 'a rate belongs to a creating launch');
END;

CREATE TRIGGER launch_rates_kept BEFORE UPDATE ON launch_rates
BEGIN
  SELECT RAISE(ABORT, 'a launch''s rate is fixed');
END;

CREATE TRIGGER launch_rates_no_delete BEFORE DELETE ON launch_rates
BEGIN
  SELECT RAISE(ABORT, 'a launch''s rate is kept');
END;

CREATE TRIGGER launches_container_rated BEFORE UPDATE OF provider_machine_id, outcome ON launches
WHEN NEW.mode = 'container'
  AND (NEW.provider_machine_id IS NOT OLD.provider_machine_id OR NEW.outcome IS NOT OLD.outcome)
  AND NOT EXISTS (SELECT 1 FROM launch_rates r WHERE r.machine_id = NEW.machine_id AND r.incarnation = NEW.incarnation)
BEGIN
  SELECT RAISE(ABORT, 'a container launch moves only with its rate');
END;

CREATE TRIGGER machine_accruals_launch_rate BEFORE INSERT ON machine_accruals
WHEN (
    EXISTS (SELECT 1 FROM launch_rates r WHERE r.machine_id = NEW.machine_id AND r.incarnation = NEW.incarnation)
    OR EXISTS (SELECT 1 FROM launches l WHERE l.machine_id = NEW.machine_id AND l.incarnation = NEW.incarnation AND l.mode = 'container')
  )
  AND NOT EXISTS (
    SELECT 1 FROM launches l JOIN launch_rates r ON r.machine_id = l.machine_id AND r.incarnation = l.incarnation
    WHERE l.machine_id = NEW.machine_id AND l.incarnation = NEW.incarnation
      AND l.provider = NEW.provider
      AND r.provider_cost_per_hour = NEW.provider_cost_per_hour AND r.margin_bps = NEW.margin_bps
      AND (l.mode <> 'container' OR l.created_ms = NEW.start_ms)
  )
BEGIN
  SELECT RAISE(ABORT, 'a launch accrues exactly at its rate (a container from its intent)');
END;
