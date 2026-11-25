-- One launch record for both launch modes (SEC clear: the container-launch design r2.1 and the
-- launch-record contract). vm_launches becomes launches, with a mode ('vm' or 'container'):
-- - the VM matrix and every VM bound carry over unchanged, now for mode = 'vm' only;
-- - a container goes creating -> issued -> enrolled (no announce, so never 'launched'), plus
--   terminate -> terminated, and carries first_running_ms, max_end_ms and credential_kind;
-- - mode, credential_kind and a set max_end_ms are fixed, and a set first_running_ms only ever
--   moves earlier (triggers below);
-- - boot_tokens carries the launch's mode (a composite key to the launch), and once its
--   provider id is set it must equal the launch's (a composite key, enforced by the database);
--   a VM token keeps today's rule exactly; a container token may be pending (no window yet);
-- - gate_reports refers to launches;
-- - one provider id is bound to at most one launch.
-- Text bounds count stored bytes and refuse a NUL, as in 0012. The container branch stays
-- unreachable: nothing writes a container launch yet.
--
-- Everything is rebuilt. VM mode is unreachable (nothing creates a launch), so no row can exist;
-- this first statement refuses the migration, before anything else here runs, if one does
-- (json() of text that isn't JSON is the error).
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM vm_launches) OR EXISTS (SELECT 1 FROM boot_tokens) OR EXISTS (SELECT 1 FROM gate_reports)
  THEN json('refused: launches exist; this rebuild assumes none')
END;

DROP TABLE gate_reports;
DROP TABLE boot_tokens;
DROP INDEX vm_launches_next;
DROP INDEX vm_launches_heartbeat_due;
DROP TABLE vm_launches;

CREATE TABLE launches (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('vm', 'container')),
  -- a VM's provider, or a container's
  provider TEXT NOT NULL CHECK ((mode = 'vm' AND provider IN ('hyperstack', 'shadeform', 'nebius')) OR (mode = 'container' AND provider IN ('runpod'))),
  -- the provider's id for the machine: null until the create has returned it
  provider_machine_id TEXT CHECK (provider_machine_id IS NULL OR (length(CAST(provider_machine_id AS BLOB)) BETWEEN 1 AND 64 AND length(provider_machine_id) = length(CAST(provider_machine_id AS BLOB)))),
  -- VM only: the launch nonce's and the exact boot script's SHA-256 (lowercase hex); the nonce itself is never stored
  nonce_sha256 TEXT CHECK (nonce_sha256 IS NULL OR (length(CAST(nonce_sha256 AS BLOB)) = 64 AND instr(nonce_sha256, char(0)) = 0 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*')),
  boot_script_sha256 TEXT CHECK (boot_script_sha256 IS NULL OR (length(CAST(boot_script_sha256 AS BLOB)) = 64 AND instr(boot_script_sha256, char(0)) = 0 AND boot_script_sha256 NOT GLOB '*[^0-9a-f]*')),
  -- the agent's SHA-256 (lowercase hex) this launch pins: enroll refuses any other
  agent_sha256 TEXT NOT NULL CHECK (length(CAST(agent_sha256 AS BLOB)) = 64 AND instr(agent_sha256, char(0)) = 0 AND agent_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- VM only: the ACTIVE facts, the VM's exclusive public IPv4 (canonical dotted form) and when it
  -- was first seen ACTIVE; both null until then, and always together
  ipv4 TEXT CHECK (ipv4 IS NULL OR (length(CAST(ipv4 AS BLOB)) BETWEEN 7 AND 15 AND length(ipv4) = length(CAST(ipv4 AS BLOB)))),
  first_active_ms INTEGER CHECK (first_active_ms IS NULL OR first_active_ms BETWEEN 0 AND 9007199254740991),
  announce_ms INTEGER CHECK (announce_ms IS NULL OR announce_ms BETWEEN 0 AND 9007199254740991),
  -- container only: when control first saw the pod running (the token's window starts here);
  -- the hard lifetime, set at enroll; whose credential the row is bound to
  first_running_ms INTEGER CHECK (first_running_ms IS NULL OR first_running_ms BETWEEN 0 AND 9007199254740991),
  max_end_ms INTEGER CHECK (max_end_ms IS NULL OR max_end_ms BETWEEN 0 AND 9007199254740991),
  credential_kind TEXT CHECK (credential_kind IS NULL OR credential_kind IN ('ours', 'org')),
  outcome TEXT NOT NULL CHECK (outcome IN ('creating', 'launched', 'issued', 'enrolled', 'terminate', 'terminated')),
  terminate_reason TEXT CHECK (terminate_reason IS NULL OR terminate_reason IN (
    'second-announce', 'provider-facts', 'provider-unavailable', 'deadline', 'issue-failed', 'watchdog-deadline', 'token-expired',
    'create-failed', 'create-deadline', 'second-enroll', 'gate-failed', 'sign-failed', 'heartbeat-lost',
    'connect-deadline', 'abort', 'eradication-failed', 'member-stop', 'idle-stop', 'max-session', 'hard-stop', 'duplicate-name', 'pod-exited')),
  -- the watchdog's per-row claim: a version every claim increments (so a claim never
  -- writes the value it read)
  watchdog_version INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_version BETWEEN 0 AND 9007199254740991),
  -- when the watchdog should next attempt the row, its one scheduling key. Null exactly when
  -- the launch is final (enrolled, or terminated).
  next_ms INTEGER CHECK (next_ms IS NULL OR next_ms BETWEEN 0 AND 9007199254740991),
  -- (as in 0013) when the heartbeat watchdog should next look at an enrolled launch: 120 s after
  -- the latest liveness, only ever moving later; kept when the launch ends
  heartbeat_due_ms INTEGER CHECK (heartbeat_due_ms IS NULL OR heartbeat_due_ms BETWEEN 0 AND 9007199254740991),
  terminated_ms INTEGER CHECK (terminated_ms IS NULL OR terminated_ms BETWEEN 0 AND 9007199254740991),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (machine_id, incarnation),
  -- (the keys boot tokens refer to: the launch with its mode, and with its provider id)
  UNIQUE (machine_id, incarnation, mode),
  UNIQUE (machine_id, incarnation, mode, provider_machine_id),
  -- the mode's own columns, and never the other mode's
  CHECK (mode <> 'vm' OR (nonce_sha256 IS NOT NULL AND boot_script_sha256 IS NOT NULL AND first_running_ms IS NULL AND max_end_ms IS NULL AND credential_kind IS NULL)),
  CHECK (mode <> 'container' OR (nonce_sha256 IS NULL AND boot_script_sha256 IS NULL AND ipv4 IS NULL AND first_active_ms IS NULL AND announce_ms IS NULL AND credential_kind IS NOT NULL)),
  -- the VM state matrix: creating has no ACTIVE facts (its id is optional); launched, issued
  -- and enrolled have the id and both ACTIVE facts; terminate and terminated may lack them
  -- (a failure before ACTIVE)
  CHECK (outcome <> 'creating' OR (ipv4 IS NULL AND first_active_ms IS NULL)),
  CHECK (mode <> 'vm' OR outcome NOT IN ('launched', 'issued', 'enrolled') OR (provider_machine_id IS NOT NULL AND ipv4 IS NOT NULL AND first_active_ms IS NOT NULL)),
  CHECK ((ipv4 IS NULL) = (first_active_ms IS NULL)),
  CHECK (mode <> 'vm' OR outcome NOT IN ('issued', 'enrolled') OR announce_ms IS NOT NULL),
  -- the container states: never launched; creating has not been seen running; issued and
  -- enrolled have the id and first running; enrolled has its lifetime; first running and the
  -- lifetime come after the intent
  CHECK (mode <> 'container' OR outcome <> 'launched'),
  CHECK (mode <> 'container' OR outcome <> 'creating' OR first_running_ms IS NULL),
  CHECK (mode <> 'container' OR outcome NOT IN ('issued', 'enrolled') OR (provider_machine_id IS NOT NULL AND first_running_ms IS NOT NULL)),
  CHECK (mode <> 'container' OR outcome IN ('enrolled', 'terminate', 'terminated') OR max_end_ms IS NULL),
  CHECK (mode <> 'container' OR outcome <> 'enrolled' OR max_end_ms IS NOT NULL),
  CHECK (first_running_ms IS NULL OR first_running_ms >= created_ms),
  CHECK (max_end_ms IS NULL OR max_end_ms > created_ms),
  -- (as in 0009) a reason exactly when terminating; terminated with its time; next_ms null
  -- exactly when final
  CHECK ((outcome IN ('terminate', 'terminated')) = (terminate_reason IS NOT NULL)),
  CHECK ((outcome = 'terminated') = (terminated_ms IS NOT NULL)),
  CHECK ((outcome IN ('enrolled', 'terminated')) = (next_ms IS NULL)),
  CHECK (outcome <> 'enrolled' OR heartbeat_due_ms IS NOT NULL)
) STRICT;
CREATE INDEX launches_next ON launches (next_ms, watchdog_version, machine_id, incarnation) WHERE next_ms IS NOT NULL;
-- the heartbeat watchdog's candidates: enrolled VM launches, in due order (a range scan, no sort)
CREATE INDEX launches_heartbeat_due ON launches (heartbeat_due_ms, machine_id, incarnation) WHERE outcome = 'enrolled' AND mode = 'vm';
CREATE TRIGGER launches_heartbeat_due_later BEFORE UPDATE OF heartbeat_due_ms ON launches
WHEN OLD.heartbeat_due_ms IS NOT NULL AND (NEW.heartbeat_due_ms IS NULL OR NEW.heartbeat_due_ms < OLD.heartbeat_due_ms)
BEGIN SELECT RAISE(ABORT, 'a heartbeat due time only moves later'); END;
-- one provider id is bound to at most one launch of that provider
CREATE UNIQUE INDEX launches_provider_id ON launches (provider, provider_machine_id) WHERE provider_machine_id IS NOT NULL;

CREATE TRIGGER launches_mode_fixed BEFORE UPDATE OF mode ON launches
WHEN NEW.mode IS NOT OLD.mode
BEGIN
  SELECT RAISE(ABORT, 'a launch''s mode is fixed');
END;

CREATE TRIGGER launches_credential_fixed BEFORE UPDATE OF credential_kind ON launches
WHEN NEW.credential_kind IS NOT OLD.credential_kind
BEGIN
  SELECT RAISE(ABORT, 'a launch''s credential kind is fixed');
END;

-- first running, once seen, only ever moves earlier (an older verified sample may commit later)
CREATE TRIGGER launches_first_running_earlier BEFORE UPDATE OF first_running_ms ON launches
WHEN OLD.first_running_ms IS NOT NULL AND (NEW.first_running_ms IS NULL OR NEW.first_running_ms > OLD.first_running_ms)
BEGIN
  SELECT RAISE(ABORT, 'first running only moves earlier');
END;

-- the hard lifetime, once set, is never rewritten
CREATE TRIGGER launches_max_end_fixed BEFORE UPDATE OF max_end_ms ON launches
WHEN OLD.max_end_ms IS NOT NULL AND NEW.max_end_ms IS NOT OLD.max_end_ms
BEGIN
  SELECT RAISE(ABORT, 'a launch''s lifetime is fixed');
END;

CREATE TABLE boot_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (length(CAST(token_sha256 AS BLOB)) = 64 AND instr(token_sha256, char(0)) = 0 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('vm', 'container')),
  provider_machine_id TEXT CHECK (provider_machine_id IS NULL OR (length(CAST(provider_machine_id AS BLOB)) BETWEEN 1 AND 64 AND length(provider_machine_id) = length(CAST(provider_machine_id AS BLOB)))),
  nonce_sha256 TEXT CHECK (nonce_sha256 IS NULL OR (length(CAST(nonce_sha256 AS BLOB)) = 64 AND instr(nonce_sha256, char(0)) = 0 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*')),
  issued_ms INTEGER CHECK (issued_ms IS NULL OR issued_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER CHECK (expires_ms IS NULL OR expires_ms BETWEEN 0 AND 9007199254740991),
  used_ms INTEGER CHECK (used_ms IS NULL OR used_ms BETWEEN 0 AND 9007199254740991),
  -- the window: both times or neither
  CHECK ((issued_ms IS NULL) = (expires_ms IS NULL)),
  -- a VM token, exactly as before: its provider id and nonce, single use, at most 120 s from issue
  CHECK (mode <> 'vm' OR (provider_machine_id IS NOT NULL AND nonce_sha256 IS NOT NULL AND issued_ms IS NOT NULL AND expires_ms > issued_ms AND expires_ms - issued_ms <= 120000)),
  -- a container token: no nonce; pending (no window, its id possibly not yet recorded) until
  -- first running, then its id and a window of exactly 120 s. (It may be used while pending:
  -- a failure revokes it before the provider is called.)
  CHECK (mode <> 'container' OR (nonce_sha256 IS NULL AND (issued_ms IS NULL OR (provider_machine_id IS NOT NULL AND expires_ms = issued_ms + 120000)))),
  -- one token per launch
  UNIQUE (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation, mode) REFERENCES launches (machine_id, incarnation, mode),
  -- once set, the token's provider id is its launch's (a null id skips this key)
  FOREIGN KEY (machine_id, incarnation, mode, provider_machine_id) REFERENCES launches (machine_id, incarnation, mode, provider_machine_id)
) STRICT;

-- The gate's report at enroll (as in 0012), now referring to launches.
CREATE TABLE gate_reports (
  machine_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  -- (json_type refuses text that isn't JSON; the bound is in stored bytes, and no NUL may hide a tail)
  words TEXT NOT NULL CHECK (json_type(words) = 'array' AND length(CAST(words AS BLOB)) <= 2048 AND instr(words, char(0)) = 0),
  at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (machine_id, incarnation),
  FOREIGN KEY (machine_id, incarnation) REFERENCES launches (machine_id, incarnation)
) STRICT;

CREATE TRIGGER gate_reports_kept BEFORE UPDATE ON gate_reports
BEGIN
  SELECT RAISE(ABORT, 'gate reports are never changed');
END;
