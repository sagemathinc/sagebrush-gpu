-- The availability record: provider listings and real launch attempts, for honest, measured
-- availability reports. Bounded: the store keeps at most 100,000 rows, pruning the oldest, and
-- availability_retention remembers how far pruning has reached, so a report over pruned time
-- says it is incomplete instead of looking unmeasured.
-- STRICT, every number in the safe-integer range; no foreign keys. The CHECKs guarantee
-- shapes and character sets; the catalog (known GPU types) is checked by checkObservation.

CREATE TABLE availability_observations (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  gpu_type TEXT NOT NULL CHECK (length(gpu_type) BETWEEN 1 AND 32 AND gpu_type NOT GLOB '*[^A-Za-z0-9-]*'),
  gpu_count INTEGER NOT NULL CHECK (gpu_count BETWEEN 1 AND 16),
  data_center TEXT NOT NULL CHECK (length(data_center) BETWEEN 1 AND 64 AND data_center NOT GLOB '*[^A-Za-z0-9._-]*'),
  country TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
  observed_ms INTEGER NOT NULL CHECK (observed_ms BETWEEN 0 AND 9007199254740991),
  source TEXT NOT NULL CHECK (source IN ('listing', 'launch')),
  outcome TEXT NOT NULL CHECK (
    (source = 'listing' AND outcome IN ('high', 'medium', 'low', 'none', 'unknown'))
    OR (source = 'launch' AND outcome IN ('launched', 'no_capacity', 'refused', 'error'))
  ),
  quoted_cost_per_hour INTEGER CHECK (quoted_cost_per_hour IS NULL OR quoted_cost_per_hour BETWEEN 0 AND 1000000000),
  ready_ms INTEGER CHECK (
    ready_ms IS NULL OR (source = 'launch' AND outcome = 'launched' AND ready_ms BETWEEN 0 AND 86400000)
  )
) STRICT;
CREATE INDEX availability_by_time ON availability_observations (observed_ms, id);

-- One row once anything has been pruned: the newest observed_ms of any pruned observation.
-- Written in the same transaction as the prune; it only ever moves forward.
CREATE TABLE availability_retention (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pruned_through_ms INTEGER NOT NULL CHECK (pruned_through_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
