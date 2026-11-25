-- VM mode: a launch is recorded BEFORE its create request (the launch-intent addendum,
-- SEC clear with its state matrix), so a VM is never billed without a row the watchdog
-- can find. A launch starts at 'creating', with no provider id and no ACTIVE facts; the
-- id comes once the create returns, and the IPv4 and first ACTIVE time at ACTIVE.
--
-- SQLite can't make a NOT NULL column nullable in place, so vm_launches is rebuilt. VM mode
-- is unreachable (nothing creates a launch), so no row can exist; this first statement
-- refuses the migration, before anything else here runs, if one does (json() of text that
-- isn't JSON is the error).
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM vm_launches) OR EXISTS (SELECT 1 FROM boot_tokens)
  THEN json('refused: VM launches exist; this rebuild assumes none')
END;

DROP INDEX vm_launches_next;
DROP TABLE vm_launches;

CREATE TABLE vm_launches (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL CHECK (provider IN ('hyperstack', 'shadeform', 'nebius')),
  -- the provider's id for the VM: null until the create has returned it
  provider_machine_id TEXT CHECK (provider_machine_id IS NULL OR length(provider_machine_id) BETWEEN 1 AND 64),
  -- the launch nonce's and the exact boot script's SHA-256 (lowercase hex); the nonce itself is never stored
  nonce_sha256 TEXT NOT NULL CHECK (length(nonce_sha256) = 64 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'),
  boot_script_sha256 TEXT NOT NULL CHECK (length(boot_script_sha256) = 64 AND boot_script_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the ACTIVE facts: the VM's exclusive public IPv4 (canonical dotted form) and when it was
  -- first seen ACTIVE; both null until then, and always together
  ipv4 TEXT CHECK (ipv4 IS NULL OR length(ipv4) BETWEEN 7 AND 15),
  first_active_ms INTEGER CHECK (first_active_ms IS NULL OR first_active_ms BETWEEN 0 AND 9007199254740991),
  announce_ms INTEGER CHECK (announce_ms IS NULL OR announce_ms BETWEEN 0 AND 9007199254740991),
  outcome TEXT NOT NULL CHECK (outcome IN ('creating', 'launched', 'issued', 'enrolled', 'terminate', 'terminated')),
  terminate_reason TEXT CHECK (terminate_reason IS NULL OR terminate_reason IN (
    'second-announce', 'provider-facts', 'provider-unavailable', 'deadline', 'issue-failed', 'watchdog-deadline', 'token-expired',
    'create-failed', 'create-deadline')),
  -- the watchdog's per-row claim: a version every claim increments (so a claim never
  -- writes the value it read)
  watchdog_version INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_version BETWEEN 0 AND 9007199254740991),
  -- when the watchdog should next attempt the row, its one scheduling key: the create
  -- deadline while creating; the announce deadline once launched; at most the token's
  -- expiry once issued; now when marked to terminate; the attempt's time after each
  -- attempt. Null exactly when the launch is final (enrolled, or terminated).
  next_ms INTEGER CHECK (next_ms IS NULL OR next_ms BETWEEN 0 AND 9007199254740991),
  terminated_ms INTEGER CHECK (terminated_ms IS NULL OR terminated_ms BETWEEN 0 AND 9007199254740991),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (machine_id, incarnation),
  -- the state matrix: creating has no ACTIVE facts (its id is optional); launched, issued
  -- and enrolled have the id and both ACTIVE facts; terminate and terminated may lack them
  -- (a failure before ACTIVE)
  CHECK (outcome <> 'creating' OR (ipv4 IS NULL AND first_active_ms IS NULL)),
  CHECK (outcome NOT IN ('launched', 'issued', 'enrolled') OR (provider_machine_id IS NOT NULL AND ipv4 IS NOT NULL AND first_active_ms IS NOT NULL)),
  CHECK ((ipv4 IS NULL) = (first_active_ms IS NULL)),
  -- (as in 0009) a reason exactly when terminating; terminated with its time; an announce
  -- before issued or enrolled; next_ms null exactly when final
  CHECK ((outcome IN ('terminate', 'terminated')) = (terminate_reason IS NOT NULL)),
  CHECK ((outcome = 'terminated') = (terminated_ms IS NOT NULL)),
  CHECK (outcome NOT IN ('issued', 'enrolled') OR announce_ms IS NOT NULL),
  CHECK ((outcome IN ('enrolled', 'terminated')) = (next_ms IS NULL))
) STRICT;
CREATE INDEX vm_launches_next ON vm_launches (next_ms, watchdog_version, machine_id, incarnation) WHERE next_ms IS NOT NULL;
