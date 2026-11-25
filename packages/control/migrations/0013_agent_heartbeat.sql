-- The agent's heartbeat (design r2, SEC clear): one row per machine incarnation with the
-- agent's latest report, and a launch's terminate reasons gain heartbeat-lost (an enrolled
-- VM silent for more than 120 s).
--
-- vm_launches is rebuilt again (a CHECK can't be changed in place). VM mode is unreachable
-- (nothing creates a launch), so no row can exist; this first statement refuses the migration,
-- before anything else here runs, if one does (json() of text that isn't JSON is the error).
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM vm_launches) OR EXISTS (SELECT 1 FROM boot_tokens) OR EXISTS (SELECT 1 FROM gate_reports)
  THEN json('refused: VM launches exist; this rebuild assumes none')
END;

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
    'create-failed', 'create-deadline', 'second-enroll', 'gate-failed', 'sign-failed', 'heartbeat-lost')),
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
-- the heartbeat watchdog's candidates: enrolled launches only
CREATE INDEX vm_launches_enrolled ON vm_launches (machine_id, incarnation) WHERE outcome = 'enrolled';

-- The agent's latest heartbeat per machine incarnation (upserted; bounded values only). Text is
-- bounded in stored bytes and holds no NUL.
CREATE TABLE machine_heartbeats (
  machine_id TEXT NOT NULL REFERENCES machines (id),
  incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 0 AND 9007199254740991),
  last_ms INTEGER NOT NULL CHECK (last_ms BETWEEN 0 AND 9007199254740991),
  uptime_s INTEGER NOT NULL CHECK (uptime_s BETWEEN 0 AND 10000000),
  last_terminal_input_ms INTEGER CHECK (last_terminal_input_ms IS NULL OR last_terminal_input_ms BETWEEN 0 AND 9007199254740991),
  last_jupyter_activity_ms INTEGER CHECK (last_jupyter_activity_ms IS NULL OR last_jupyter_activity_ms BETWEEN 0 AND 9007199254740991),
  gpu_util_pct INTEGER CHECK (gpu_util_pct IS NULL OR gpu_util_pct BETWEEN 0 AND 100),
  gpu_mem_used_mib INTEGER CHECK (gpu_mem_used_mib IS NULL OR gpu_mem_used_mib BETWEEN 0 AND 4194304),
  idle_since_ms INTEGER CHECK (idle_since_ms IS NULL OR idle_since_ms BETWEEN 0 AND 9007199254740991),
  save_state TEXT NOT NULL CHECK (save_state IN ('idle', 'saving', 'failed')),
  save_last_ms INTEGER CHECK (save_last_ms IS NULL OR save_last_ms BETWEEN 0 AND 9007199254740991),
  save_bytes_done INTEGER CHECK (save_bytes_done IS NULL OR save_bytes_done BETWEEN 0 AND 9007199254740991),
  save_bytes_total INTEGER CHECK (save_bytes_total IS NULL OR save_bytes_total BETWEEN 0 AND 9007199254740991),
  save_error TEXT CHECK (save_error IS NULL OR (length(CAST(save_error AS BLOB)) BETWEEN 1 AND 200 AND instr(save_error, char(0)) = 0)),
  save_snapshot_id TEXT CHECK (save_snapshot_id IS NULL OR (length(CAST(save_snapshot_id AS BLOB)) BETWEEN 1 AND 64 AND instr(save_snapshot_id, char(0)) = 0)),
  dirty_bytes INTEGER NOT NULL CHECK (dirty_bytes BETWEEN 0 AND 9007199254740991),
  CHECK ((save_bytes_done IS NULL) = (save_bytes_total IS NULL) AND (save_bytes_done IS NULL OR save_bytes_done <= save_bytes_total)),
  PRIMARY KEY (machine_id, incarnation)
) STRICT;
CREATE INDEX machine_heartbeats_last ON machine_heartbeats (last_ms);
