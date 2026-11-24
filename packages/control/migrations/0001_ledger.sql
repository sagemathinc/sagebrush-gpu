-- The ledger and what it charges against. Money is integer micro-USD; times are integer
-- Unix milliseconds (UTC). The ledger rule: one compute entry per machine per UTC minute,
-- at the rate recorded on the machine when it started, never updated once written.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  created_ms INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  name TEXT NOT NULL,
  starts_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL CHECK (ends_ms > starts_ms),
  margin_bps_override INTEGER CHECK (margin_bps_override IS NULL OR margin_bps_override BETWEEN 0 AND 1000000),
  budget INTEGER NOT NULL CHECK (budget >= 0),
  final_save_reserve_minutes INTEGER NOT NULL DEFAULT 10 CHECK (final_save_reserve_minutes BETWEEN 0 AND 1440),
  created_ms INTEGER NOT NULL
);

CREATE TABLE allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('member', 'team')),
  holder_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  updated_ms INTEGER NOT NULL,
  UNIQUE (project_id, holder_kind, holder_id)
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  allocation_id TEXT NOT NULL REFERENCES allocations (id),
  member_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  provider_machine_id TEXT,
  gpu_type TEXT NOT NULL,
  gpu_count INTEGER NOT NULL CHECK (gpu_count >= 1),
  data_center TEXT NOT NULL,
  -- the rate snapshot, fixed at start
  provider_cost_per_hour INTEGER NOT NULL CHECK (provider_cost_per_hour >= 0),
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'saving', 'stopping', 'stopped', 'failed', 'deleted')),
  incarnation INTEGER NOT NULL DEFAULT 0 CHECK (incarnation >= 0),
  -- accrual runs from placement until the provider confirms the stop
  accrual_start_ms INTEGER,
  accrual_end_ms INTEGER,
  -- the end of the last billed minute: always a minute boundary
  billed_through_ms INTEGER,
  -- the agent's estimate of the final save, in seconds (untrusted; capped by its producer)
  save_estimate_seconds INTEGER NOT NULL DEFAULT 0 CHECK (save_estimate_seconds BETWEEN 0 AND 86400),
  created_ms INTEGER NOT NULL,
  CHECK (accrual_start_ms IS NOT NULL OR (accrual_end_ms IS NULL AND billed_through_ms IS NULL)),
  CHECK (accrual_start_ms IS NULL OR (billed_through_ms IS NOT NULL AND billed_through_ms % 60000 = 0 AND billed_through_ms > accrual_start_ms - 60000)),
  CHECK (accrual_end_ms IS NULL OR accrual_end_ms >= accrual_start_ms)
);

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  allocation_id TEXT NOT NULL REFERENCES allocations (id),
  kind TEXT NOT NULL CHECK (kind IN ('compute', 'storage', 'egress', 'adjustment')),
  machine_id TEXT REFERENCES machines (id),
  provider TEXT,
  period_start_ms INTEGER NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  provider_cost_per_hour INTEGER,
  margin_bps INTEGER NOT NULL CHECK (margin_bps BETWEEN 0 AND 1000000),
  provider_cost INTEGER NOT NULL,
  margin INTEGER NOT NULL,
  total INTEGER NOT NULL,
  note TEXT,
  created_ms INTEGER NOT NULL,
  CHECK (total = provider_cost + margin),
  CHECK (kind <> 'compute' OR (
    machine_id IS NOT NULL AND provider IS NOT NULL AND provider_cost_per_hour IS NOT NULL
    AND period_start_ms % 60000 = 0 AND seconds BETWEEN 1 AND 60
    AND provider_cost >= 0 AND margin >= 0
  ))
);

-- One compute entry per machine per minute: a second accrual of the same minute fails.
CREATE UNIQUE INDEX ledger_compute_minute ON ledger_entries (machine_id, period_start_ms) WHERE kind = 'compute';
CREATE INDEX ledger_by_allocation ON ledger_entries (allocation_id);
CREATE INDEX machines_accruing ON machines (allocation_id) WHERE accrual_start_ms IS NOT NULL;
