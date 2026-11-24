-- The ledger and what it charges against.
--
-- Money is integer micro-USD; times are integer Unix milliseconds (UTC). Every table is
-- STRICT (an INTEGER column holds only integers), and every number is bounded to
-- [0, 9007199254740991] (Number.MAX_SAFE_INTEGER), so JavaScript reads it exactly.
--
-- The ledger rule: one compute entry per machine per UTC minute, written once the
-- minute has closed, for the seconds of all the machine's accrual intervals in that
-- minute (summed, rounded up once, at most 60), at the PINNED rate: that of the
-- machine's first fragment in the minute. A new placement's rate applies from the next
-- minute. Entries are never updated or deleted.
--
-- Ownership is one tuple: an allocation belongs to one project, a project to one org,
-- a machine to one (project, allocation), and a compute entry to its machine's
-- (org, project, allocation), with the provider, rate and margin of the minute's pinned
-- fragment. Composite foreign keys and triggers enforce the whole tuple.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  name TEXT NOT NULL,
  starts_ms INTEGER NOT NULL CHECK (starts_ms BETWEEN 0 AND 9007199254740991),
  ends_ms INTEGER NOT NULL CHECK (ends_ms BETWEEN 0 AND 9007199254740991),
  margin_bps_override INTEGER CHECK (margin_bps_override IS NULL OR margin_bps_override BETWEEN 0 AND 1000000),
  budget INTEGER NOT NULL CHECK (budget BETWEEN 0 AND 9007199254740991),
  final_save_reserve_minutes INTEGER NOT NULL DEFAULT 10 CHECK (final_save_reserve_minutes BETWEEN 0 AND 1440),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  CHECK (ends_ms > starts_ms),
  UNIQUE (id, org_id)
) STRICT;

CREATE TABLE allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('member', 'team')),
  holder_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 0 AND 9007199254740991),
  updated_ms INTEGER NOT NULL CHECK (updated_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (project_id, holder_kind, holder_id),
  UNIQUE (id, project_id)
) STRICT;

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  allocation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  provider_machine_id TEXT,
  gpu_type TEXT NOT NULL,
  gpu_count INTEGER NOT NULL CHECK (gpu_count BETWEEN 1 AND 64),
  data_center TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'saving', 'stopping', 'stopped', 'failed', 'deleted')),
  incarnation INTEGER NOT NULL DEFAULT 0 CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  -- the end of the last billed minute: a minute boundary; set with the first interval
  billed_through_ms INTEGER CHECK (billed_through_ms IS NULL OR (billed_through_ms BETWEEN 0 AND 9007199254740991 AND billed_through_ms % 60000 = 0)),
  -- the agent's estimate of the final save, in seconds (untrusted; capped by its producer)
  save_estimate_seconds INTEGER NOT NULL DEFAULT 0 CHECK (save_estimate_seconds BETWEEN 0 AND 86400),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  -- the allocation must be one of the machine's own project
  FOREIGN KEY (allocation_id, project_id) REFERENCES allocations (id, project_id),
  UNIQUE (id, project_id, allocation_id)
) STRICT;

-- When a machine accrues: one interval per incarnation (placement), with that
-- placement's rate snapshot, from placement until the provider confirms the stop.
-- Intervals of a machine are ordered and disjoint, at most one is open, none starts
-- before the machine's billed-through mark, and an interval can only be closed, once,
-- not before that mark. They are never deleted.
CREATE TABLE machine_accruals (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  provider_cost_per_hour INTEGER NOT NULL CHECK (provider_cost_per_hour BETWEEN 0 AND 9007199254740991),
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  start_ms INTEGER NOT NULL CHECK (start_ms BETWEEN 0 AND 9007199254740991),
  end_ms INTEGER CHECK (end_ms IS NULL OR (end_ms BETWEEN 0 AND 9007199254740991 AND end_ms >= start_ms)),
  PRIMARY KEY (machine_id, incarnation)
) STRICT;
CREATE UNIQUE INDEX machine_accruals_one_open ON machine_accruals (machine_id) WHERE end_ms IS NULL;

CREATE TRIGGER machine_accruals_ordered BEFORE INSERT ON machine_accruals
WHEN EXISTS (
  SELECT 1 FROM machine_accruals a
  WHERE a.machine_id = NEW.machine_id AND (a.end_ms IS NULL OR a.end_ms > NEW.start_ms OR a.incarnation >= NEW.incarnation)
) OR NEW.start_ms < (SELECT billed_through_ms FROM machines WHERE id = NEW.machine_id)
BEGIN
  SELECT RAISE(ABORT, 'accrual intervals must be ordered, disjoint and unbilled');
END;

CREATE TRIGGER machine_accruals_close_once BEFORE UPDATE ON machine_accruals
WHEN OLD.end_ms IS NOT NULL OR NEW.end_ms IS NULL
  OR NEW.machine_id <> OLD.machine_id OR NEW.incarnation <> OLD.incarnation OR NEW.start_ms <> OLD.start_ms
  OR NEW.provider <> OLD.provider OR NEW.provider_cost_per_hour <> OLD.provider_cost_per_hour OR NEW.margin_bps <> OLD.margin_bps
  OR NEW.end_ms < (SELECT billed_through_ms FROM machines WHERE id = NEW.machine_id)
BEGIN
  SELECT RAISE(ABORT, 'an accrual interval can only be closed, once, after its billed minutes');
END;

CREATE TRIGGER machine_accruals_no_delete BEFORE DELETE ON machine_accruals
BEGIN
  SELECT RAISE(ABORT, 'accrual intervals are kept');
END;

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('compute', 'storage', 'egress', 'adjustment')),
  machine_id TEXT,
  provider TEXT,
  period_start_ms INTEGER NOT NULL CHECK (period_start_ms BETWEEN 0 AND 9007199254740991),
  seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 9007199254740991),
  provider_cost_per_hour INTEGER CHECK (provider_cost_per_hour IS NULL OR provider_cost_per_hour BETWEEN 0 AND 9007199254740991),
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  -- adjustments may be negative (refunds); compute charges never are
  provider_cost INTEGER NOT NULL CHECK (provider_cost BETWEEN -9007199254740991 AND 9007199254740991),
  margin INTEGER NOT NULL CHECK (margin BETWEEN -9007199254740991 AND 9007199254740991),
  total INTEGER NOT NULL CHECK (total BETWEEN -9007199254740991 AND 9007199254740991),
  note TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  CHECK (total = provider_cost + margin),
  CHECK (kind <> 'compute' OR (
    machine_id IS NOT NULL AND provider IS NOT NULL AND provider_cost_per_hour IS NOT NULL
    AND period_start_ms % 60000 = 0 AND seconds BETWEEN 1 AND 60
    AND provider_cost >= 0 AND margin >= 0
    -- exactly entrySplit: the provider cost is rate * seconds / 3600 rounded half-up, and
    -- the margin is cost * bps / 10000 rounded half-up (floor((2n + d) / 2d) on integers).
    -- The products are bounded first, as entrySplit bounds them, so nothing overflows.
    AND provider_cost_per_hour * seconds <= 9007199254740991
    AND provider_cost = (provider_cost_per_hour * seconds * 2 + 3600) / 7200
    AND provider_cost * margin_bps <= 9007199254740991
    AND margin = (provider_cost * margin_bps * 2 + 10000) / 20000
  )),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  FOREIGN KEY (allocation_id, project_id) REFERENCES allocations (id, project_id),
  FOREIGN KEY (machine_id, project_id, allocation_id) REFERENCES machines (id, project_id, allocation_id)
) STRICT;

-- One compute entry per machine per minute: a second accrual of the same minute fails.
CREATE UNIQUE INDEX ledger_compute_minute ON ledger_entries (machine_id, period_start_ms) WHERE kind = 'compute';
CREATE INDEX ledger_by_allocation ON ledger_entries (allocation_id);

-- A compute entry's provider, rate and margin are those of the minute's pinned fragment:
-- the machine's earliest accrual interval overlapping that minute.
CREATE TRIGGER ledger_compute_pinned_rate BEFORE INSERT ON ledger_entries
WHEN NEW.kind = 'compute' AND NOT EXISTS (
  SELECT 1 FROM (
    SELECT a.provider, a.provider_cost_per_hour, a.margin_bps FROM machine_accruals a
    WHERE a.machine_id = NEW.machine_id
      AND a.start_ms < NEW.period_start_ms + 60000
      AND (a.end_ms IS NULL OR a.end_ms > NEW.period_start_ms)
    ORDER BY a.start_ms LIMIT 1
  ) p
  WHERE p.provider = NEW.provider AND p.provider_cost_per_hour = NEW.provider_cost_per_hour AND p.margin_bps = NEW.margin_bps
)
BEGIN
  SELECT RAISE(ABORT, 'a compute entry must carry its minute''s pinned provider, rate and margin');
END;

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are never updated');
END;

CREATE TRIGGER ledger_entries_kept BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are never deleted');
END;

CREATE INDEX machine_accruals_open ON machine_accruals (machine_id) WHERE end_ms IS NULL;
