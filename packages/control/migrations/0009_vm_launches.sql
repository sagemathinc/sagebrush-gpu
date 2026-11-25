-- VM mode (design draft 5, announce contract r3, SEC clear): a launch's public facts and
-- its one announce, and the boot tokens the announce issues (their hashes only).

CREATE TABLE vm_launches (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL CHECK (provider IN ('hyperstack')),
  provider_machine_id TEXT NOT NULL CHECK (length(provider_machine_id) BETWEEN 1 AND 64),
  -- the launch nonce's and the exact boot script's SHA-256 (lowercase hex); the nonce itself is never stored
  nonce_sha256 TEXT NOT NULL CHECK (length(nonce_sha256) = 64 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'),
  boot_script_sha256 TEXT NOT NULL CHECK (length(boot_script_sha256) = 64 AND boot_script_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the VM's exclusive public IPv4 as the provider reported it at ACTIVE (canonical dotted form)
  ipv4 TEXT NOT NULL CHECK (length(ipv4) BETWEEN 7 AND 15),
  first_active_ms INTEGER NOT NULL CHECK (first_active_ms BETWEEN 0 AND 9007199254740991),
  announce_ms INTEGER CHECK (announce_ms IS NULL OR announce_ms BETWEEN 0 AND 9007199254740991),
  outcome TEXT NOT NULL DEFAULT 'launched' CHECK (outcome IN ('launched', 'issued', 'enrolled', 'terminate', 'terminated')),
  terminate_reason TEXT CHECK (terminate_reason IS NULL OR terminate_reason IN (
    'second-announce', 'provider-facts', 'provider-unavailable', 'deadline', 'issue-failed', 'watchdog-deadline', 'token-expired')),
  -- the watchdog's per-row claim: a version every claim increments (so a claim never
  -- writes the value it read)
  watchdog_version INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_version BETWEEN 0 AND 9007199254740991),
  -- when the watchdog should next attempt the row, its one scheduling key: the announce
  -- deadline while launched; at most the token's expiry once issued; now when marked to
  -- terminate; the attempt's time after each attempt (so it goes behind every row due
  -- earlier). Null exactly when the launch is final (enrolled, or terminated), which keeps
  -- final history out of the watchdog's index.
  next_ms INTEGER CHECK (next_ms IS NULL OR next_ms BETWEEN 0 AND 9007199254740991),
  terminated_ms INTEGER CHECK (terminated_ms IS NULL OR terminated_ms BETWEEN 0 AND 9007199254740991),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (machine_id, incarnation),
  -- a reason exactly when the launch is being or has been terminated; an announce time once it's past 'launched' by announce
  CHECK ((outcome IN ('terminate', 'terminated')) = (terminate_reason IS NOT NULL)),
  CHECK ((outcome = 'terminated') = (terminated_ms IS NOT NULL)),
  CHECK (outcome NOT IN ('issued', 'enrolled') OR announce_ms IS NOT NULL),
  CHECK ((outcome IN ('enrolled', 'terminated')) = (next_ms IS NULL))
) STRICT;
-- the watchdog's search: a range scan in its own order, stopping at its batch; rows not yet
-- due, and final history, are never read
CREATE INDEX vm_launches_next ON vm_launches (next_ms, watchdog_version, machine_id, incarnation) WHERE next_ms IS NOT NULL;

CREATE TABLE boot_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  provider_machine_id TEXT NOT NULL CHECK (length(provider_machine_id) BETWEEN 1 AND 64),
  nonce_sha256 TEXT NOT NULL CHECK (length(nonce_sha256) = 64),
  issued_ms INTEGER NOT NULL CHECK (issued_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  used_ms INTEGER CHECK (used_ms IS NULL OR used_ms BETWEEN 0 AND 9007199254740991),
  -- single use, at most 120 s from issue
  CHECK (expires_ms > issued_ms AND expires_ms - issued_ms <= 120000),
  -- one token per launch
  UNIQUE (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation) REFERENCES vm_launches (machine_id, incarnation)
) STRICT;
