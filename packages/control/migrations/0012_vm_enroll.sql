-- VM enroll (design r3, SEC clear): a launch pins the agent's hash at its intent, and the
-- launch's terminate reasons gain the enroll's definitive failures (a second use of a boot
-- token, a failing gate report, a signing failure after the commit). The gate's report is
-- kept per launch, and enroll_guard is the enroll batch's all-or-nothing guard.
--
-- Text bounds count stored bytes, not characters, and no bounded text may hold a NUL: SQLite's
-- length() and GLOB stop at an embedded NUL. The hashes are exactly 64 bytes, no NUL, lowercase
-- hex; the provider id and the IPv4 are ASCII (characters and bytes agree, which no NUL or
-- multibyte character passes); the gate's words are at most 2048 bytes, no NUL.
--
-- vm_launches and boot_tokens are rebuilt (a CHECK and a NOT NULL column can't be changed in place). VM mode is
-- unreachable (nothing creates a launch), so no row can exist; this first statement refuses
-- the migration, before anything else here runs, if one does (json() of text that isn't JSON
-- is the error).
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM vm_launches) OR EXISTS (SELECT 1 FROM boot_tokens)
  THEN json('refused: VM launches exist; this rebuild assumes none')
END;

DROP TABLE boot_tokens;
DROP INDEX vm_launches_next;
DROP TABLE vm_launches;

CREATE TABLE vm_launches (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL CHECK (provider IN ('hyperstack', 'shadeform', 'nebius')),
  -- the provider's id for the VM: null until the create has returned it
  provider_machine_id TEXT CHECK (provider_machine_id IS NULL OR (length(CAST(provider_machine_id AS BLOB)) BETWEEN 1 AND 64 AND length(provider_machine_id) = length(CAST(provider_machine_id AS BLOB)))),
  -- the launch nonce's and the exact boot script's SHA-256 (lowercase hex); the nonce itself is never stored
  nonce_sha256 TEXT NOT NULL CHECK (length(CAST(nonce_sha256 AS BLOB)) = 64 AND instr(nonce_sha256, char(0)) = 0 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'),
  boot_script_sha256 TEXT NOT NULL CHECK (length(CAST(boot_script_sha256 AS BLOB)) = 64 AND instr(boot_script_sha256, char(0)) = 0 AND boot_script_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the agent's SHA-256 (lowercase hex) this launch pins: enroll refuses any other
  agent_sha256 TEXT NOT NULL CHECK (length(CAST(agent_sha256 AS BLOB)) = 64 AND instr(agent_sha256, char(0)) = 0 AND agent_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- the ACTIVE facts: the VM's exclusive public IPv4 (canonical dotted form) and when it was
  -- first seen ACTIVE; both null until then, and always together
  ipv4 TEXT CHECK (ipv4 IS NULL OR (length(CAST(ipv4 AS BLOB)) BETWEEN 7 AND 15 AND length(ipv4) = length(CAST(ipv4 AS BLOB)))),
  first_active_ms INTEGER CHECK (first_active_ms IS NULL OR first_active_ms BETWEEN 0 AND 9007199254740991),
  announce_ms INTEGER CHECK (announce_ms IS NULL OR announce_ms BETWEEN 0 AND 9007199254740991),
  outcome TEXT NOT NULL CHECK (outcome IN ('creating', 'launched', 'issued', 'enrolled', 'terminate', 'terminated')),
  terminate_reason TEXT CHECK (terminate_reason IS NULL OR terminate_reason IN (
    'second-announce', 'provider-facts', 'provider-unavailable', 'deadline', 'issue-failed', 'watchdog-deadline', 'token-expired',
    'create-failed', 'create-deadline', 'second-enroll', 'gate-failed', 'sign-failed')),
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

-- (as in 0009, with its text bounded in bytes)
CREATE TABLE boot_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (length(CAST(token_sha256 AS BLOB)) = 64 AND instr(token_sha256, char(0)) = 0 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  provider_machine_id TEXT NOT NULL CHECK (length(CAST(provider_machine_id AS BLOB)) BETWEEN 1 AND 64 AND length(provider_machine_id) = length(CAST(provider_machine_id AS BLOB))),
  nonce_sha256 TEXT NOT NULL CHECK (length(CAST(nonce_sha256 AS BLOB)) = 64 AND instr(nonce_sha256, char(0)) = 0 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_ms INTEGER NOT NULL CHECK (issued_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  used_ms INTEGER CHECK (used_ms IS NULL OR used_ms BETWEEN 0 AND 9007199254740991),
  -- single use, at most 120 s from issue
  CHECK (expires_ms > issued_ms AND expires_ms - issued_ms <= 120000),
  -- one token per launch
  UNIQUE (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation) REFERENCES vm_launches (machine_id, incarnation)
) STRICT;

-- The gate's report at enroll, canonical (sorted, distinct, known words; JSON text), one per
-- launch, written in the same batch as the enroll or its gate-failed termination.
CREATE TABLE gate_reports (
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  -- (json_type refuses text that isn't JSON; the bound is in stored bytes, and no NUL may hide a tail)
  words TEXT NOT NULL CHECK (json_type(words) = 'array' AND length(CAST(words AS BLOB)) <= 2048 AND instr(words, char(0)) = 0),
  at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation) REFERENCES vm_launches (machine_id, incarnation)
) STRICT;

CREATE TRIGGER gate_reports_kept BEFORE UPDATE ON gate_reports
BEGIN
  SELECT RAISE(ABORT, 'gate reports are never changed');
END;

-- Never holds a row: a batch's last statement inserts 0 here exactly when one of its
-- conditional writes didn't take effect, and the CHECK then rolls the whole batch back.
CREATE TABLE enroll_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;
