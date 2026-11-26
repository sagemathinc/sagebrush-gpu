-- Starting a machine: admission (design r3, start-admission, SEC and LIMITS clear; new machines
-- only). An admitted machine is written in 'starting' with the rate it was admitted at, and that
-- rate is a liability of its allocation until its accrual opens (then the interval counts it) or
-- it leaves 'starting' (src/start.ts):
-- - allocations.start_version: each admission's compare-and-swap, so of two admissions that read
--   the same state only one commits; it only steps up by 1.
-- - machines.admitted_cost_per_hour, admitted_margin_bps: the admitted rate, both or neither,
--   fixed once set.
-- - A launch of an admitted machine is bound to it: its rate (launch_rates) is the admitted
--   rate, its provider the machine's, and it is recorded only while that exact machine and
--   incarnation is 'starting' (so a start cleaned up as stale can't be launched late: H4).

ALTER TABLE allocations ADD COLUMN start_version INTEGER NOT NULL DEFAULT 0 CHECK (start_version BETWEEN 0 AND 9007199254740991);

CREATE TRIGGER allocations_start_version_step BEFORE UPDATE OF start_version ON allocations
WHEN NEW.start_version IS NOT OLD.start_version AND NEW.start_version IS NOT OLD.start_version + 1
BEGIN
  SELECT RAISE(ABORT, 'an allocation''s start version only steps up by 1');
END;

ALTER TABLE machines ADD COLUMN admitted_cost_per_hour INTEGER
  CHECK (admitted_cost_per_hour IS NULL OR admitted_cost_per_hour BETWEEN 0 AND 1000000000);
ALTER TABLE machines ADD COLUMN admitted_margin_bps INTEGER
  CHECK (admitted_margin_bps IS NULL OR admitted_margin_bps BETWEEN 0 AND 1000000)
  CHECK ((admitted_margin_bps IS NULL) = (admitted_cost_per_hour IS NULL));

CREATE TRIGGER machines_admitted_rate_fixed BEFORE UPDATE OF admitted_cost_per_hour, admitted_margin_bps ON machines
WHEN NEW.admitted_cost_per_hour IS NOT OLD.admitted_cost_per_hour OR NEW.admitted_margin_bps IS NOT OLD.admitted_margin_bps
BEGIN
  SELECT RAISE(ABORT, 'a machine''s admitted rate is fixed');
END;

CREATE TRIGGER launch_rates_admitted BEFORE INSERT ON launch_rates
WHEN EXISTS (
  SELECT 1 FROM machines m WHERE m.id = NEW.machine_id AND m.admitted_cost_per_hour IS NOT NULL
    AND (m.admitted_cost_per_hour IS NOT NEW.provider_cost_per_hour OR m.admitted_margin_bps IS NOT NEW.margin_bps)
)
BEGIN
  SELECT RAISE(ABORT, 'a launch''s rate is its machine''s admitted rate');
END;

CREATE TRIGGER launches_admitted_provider BEFORE INSERT ON launches
WHEN EXISTS (SELECT 1 FROM machines m WHERE m.id = NEW.machine_id AND m.admitted_cost_per_hour IS NOT NULL AND m.provider IS NOT NEW.provider)
BEGIN
  SELECT RAISE(ABORT, 'a launch''s provider is its machine''s admitted provider');
END;

CREATE TRIGGER launches_admitted_starting BEFORE INSERT ON launches
WHEN EXISTS (SELECT 1 FROM machines m WHERE m.id = NEW.machine_id AND m.admitted_cost_per_hour IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM machines m WHERE m.id = NEW.machine_id AND m.state = 'starting' AND m.incarnation = NEW.incarnation)
BEGIN
  SELECT RAISE(ABORT, 'a launch is recorded only while its machine is starting at that incarnation');
END;

-- (the admissions' and the stale cleanup's reads: an allocation's machines still starting)
CREATE INDEX machines_starting ON machines (allocation_id) WHERE state = 'starting';
