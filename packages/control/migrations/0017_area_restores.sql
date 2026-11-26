-- Workspace snapshots: restore's exclusion (the snapshot contract r3.1, SEC DESIGN CLEAR, section 4).
--
-- 1. A machine's area keys, pinned at `starting` (4.0): the areas its workspace token may write,
--    `m:<prj>:<mbr>` and `t:<prj>:<team>` (null without a team), derived from membership at that
--    moment and never re-derived. The workspace token is minted from these columns. While the
--    machine isn't final they don't change (trigger below): a key change needs OLD.state final
--    (stopped, failed or deleted), so a restart that changes them goes through `stopped`, and its
--    old token ends with that stop (N1). A machine that keeps running after its member moves team
--    or leaves still counts as a writer of the old areas, until it stops.
-- 2. area_restores (4.1): one row per restore operation, kept forever (who restored what, and the
--    outcome). At most one live claim per area (the partial unique index). A claim moves one way:
--    claimed, then done, failed or expired, and only reconciliation ends it, never a time-based
--    guard (C2). expected_head is set once, after the claim (4.3), then the token's exp, which
--    with the 30 s skew allowed is never past the 120 s lease (N2).
--
-- A machine live before this migration (or never pinned) has null keys, and would be invisible to
-- a guard that matches keys only. So the claim's writer guard (4.1, control's statement) also
-- blocks on ANY live machine of the same project whose member_area_key is null:
--   NOT EXISTS (SELECT 1 FROM machines WHERE state IN ('starting', 'running', 'saving', 'stopping')
--     AND (member_area_key = :area OR team_area_key = :area OR (member_area_key IS NULL AND project_id = :project)))
-- and the triggers below keep any machine from becoming live without its member key, so such rows
-- only ever drain away (a live machine may still move between live states, and stop).
--
-- The conditional batches (the claim's writer guard, the start's claim guard), the HEAD read,
-- the token and reconciliation are control's code; this is their schema. Ids are checked to
-- their exact shapes (Crockford base 32, as ids.ts) and byte lengths (GLOB stops at a NUL, as in
-- 0012), so every key is plain ASCII.

ALTER TABLE machines ADD COLUMN member_area_key TEXT CHECK (member_area_key IS NULL OR length(CAST(member_area_key AS BLOB)) = 51 AND member_area_key GLOB 'm:prj_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]:mbr_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]');
ALTER TABLE machines ADD COLUMN team_area_key TEXT CHECK (team_area_key IS NULL OR length(CAST(team_area_key AS BLOB)) = 52 AND team_area_key GLOB 't:prj_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]:team_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]' AND (team_area_key IS NULL OR member_area_key IS NOT NULL));

-- the writers of an area, as the claim's guard looks for them
CREATE INDEX machines_writers_member_area ON machines (member_area_key) WHERE member_area_key IS NOT NULL AND state IN ('starting', 'running', 'saving', 'stopping');
CREATE INDEX machines_writers_team_area ON machines (team_area_key) WHERE team_area_key IS NOT NULL AND state IN ('starting', 'running', 'saving', 'stopping');

-- the area keys change only while the machine is final, before (or in the statement of) its
-- move into `starting` (N1)
CREATE TRIGGER machines_area_keys_pinned BEFORE UPDATE OF member_area_key, team_area_key ON machines
WHEN (NEW.member_area_key IS NOT OLD.member_area_key OR NEW.team_area_key IS NOT OLD.team_area_key)
  AND OLD.state NOT IN ('stopped', 'failed', 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'a machine''s area keys change only through a final state');
END;

-- a machine becomes live (starting, running, saving or stopping) only with its member area key
-- pinned, whether inserted live or moved into a live state; its team key may be null (no team at
-- its start: its workspace token, minted from these columns, then has no team grant)
CREATE TRIGGER machines_live_keys_insert BEFORE INSERT ON machines
WHEN NEW.state IN ('starting', 'running', 'saving', 'stopping') AND NEW.member_area_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a machine becomes live only with its area keys pinned');
END;
CREATE TRIGGER machines_live_keys_update BEFORE UPDATE OF state ON machines
WHEN NEW.state IN ('starting', 'running', 'saving', 'stopping') AND OLD.state NOT IN ('starting', 'running', 'saving', 'stopping') AND NEW.member_area_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a machine becomes live only with its area keys pinned');
END;
-- (the claim guard's keyless live machines of a project)
CREATE INDEX machines_live_keyless ON machines (project_id) WHERE member_area_key IS NULL AND state IN ('starting', 'running', 'saving', 'stopping');

CREATE TABLE area_restores (
  -- the operation (16 random bytes, base64url), carried in the restore manifest as `op`
  op_id TEXT PRIMARY KEY CHECK (length(CAST(op_id AS BLOB)) = 22 AND instr(op_id, char(0)) = 0 AND op_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  area_key TEXT NOT NULL CHECK ((length(CAST(area_key AS BLOB)) = 51 AND area_key GLOB 'm:prj_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]:mbr_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]') OR (length(CAST(area_key AS BLOB)) = 52 AND area_key GLOB 't:prj_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]:team_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]')),
  actor_member_id TEXT NOT NULL REFERENCES members (id),
  target_snapshot_id TEXT NOT NULL CHECK (length(CAST(target_snapshot_id AS BLOB)) = 24 AND target_snapshot_id GLOB 'snp_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]'),
  -- HEAD as read after the claim (4.3); null until then
  expected_head TEXT CHECK (expected_head IS NULL OR length(CAST(expected_head AS BLOB)) = 24 AND expected_head GLOB 'snp_[0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]'),
  -- the restore token's id (the gateway's op marker is keyed by it): one token per operation
  jti TEXT NOT NULL UNIQUE CHECK (length(CAST(jti AS BLOB)) = 22 AND instr(jti, char(0)) = 0 AND jti NOT GLOB '*[^A-Za-z0-9_-]*'),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'done', 'failed', 'expired')),
  -- the token's exp, ms; null until it is minted, which needs expected_head
  token_exp_ms INTEGER CHECK (token_exp_ms IS NULL OR token_exp_ms BETWEEN 0 AND 9007199254740991),
  lease_ms INTEGER NOT NULL CHECK (lease_ms = 120000),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  CHECK (token_exp_ms IS NULL OR expected_head IS NOT NULL),
  -- exp after the claim, and exp + the 30 s skew within the lease (N2)
  CHECK (token_exp_ms IS NULL OR (token_exp_ms > created_ms AND token_exp_ms + 30000 <= created_ms + lease_ms))
) STRICT;

-- one live claim per area
CREATE UNIQUE INDEX area_restores_live ON area_restores (area_key) WHERE state = 'claimed';

-- a claim starts as a claim, with no HEAD read (and so, by the table's check, no token yet)
CREATE TRIGGER area_restores_claim_first BEFORE INSERT ON area_restores
WHEN NEW.state <> 'claimed' OR NEW.expected_head IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a restore starts as a bare claim');
END;

-- claimed, then done, failed or expired, one way
CREATE TRIGGER area_restores_state_one_way BEFORE UPDATE OF state ON area_restores
WHEN NEW.state IS NOT OLD.state AND NOT (OLD.state = 'claimed' AND NEW.state IN ('done', 'failed', 'expired'))
BEGIN
  SELECT RAISE(ABORT, 'a restore claim only ends, once');
END;

-- what the operation is, from its claim
CREATE TRIGGER area_restores_identity_fixed BEFORE UPDATE OF op_id, area_key, actor_member_id, target_snapshot_id, jti, lease_ms, created_ms ON area_restores
WHEN NEW.op_id IS NOT OLD.op_id
  OR NEW.area_key IS NOT OLD.area_key
  OR NEW.actor_member_id IS NOT OLD.actor_member_id
  OR NEW.target_snapshot_id IS NOT OLD.target_snapshot_id
  OR NEW.jti IS NOT OLD.jti
  OR NEW.lease_ms IS NOT OLD.lease_ms
  OR NEW.created_ms IS NOT OLD.created_ms
BEGIN
  SELECT RAISE(ABORT, 'a restore''s identity is fixed');
END;

-- expected_head and the token's exp are each set once, while the claim is live (so a token is
-- never minted again for the same operation)
CREATE TRIGGER area_restores_head_once BEFORE UPDATE OF expected_head ON area_restores
WHEN NEW.expected_head IS NOT OLD.expected_head AND (OLD.expected_head IS NOT NULL OR OLD.state <> 'claimed')
BEGIN
  SELECT RAISE(ABORT, 'a restore''s expected head is set once, while claimed');
END;
CREATE TRIGGER area_restores_token_once BEFORE UPDATE OF token_exp_ms ON area_restores
WHEN NEW.token_exp_ms IS NOT OLD.token_exp_ms AND (OLD.token_exp_ms IS NOT NULL OR OLD.state <> 'claimed')
BEGIN
  SELECT RAISE(ABORT, 'a restore''s token is minted once, while claimed');
END;

CREATE TRIGGER area_restores_kept BEFORE DELETE ON area_restores
BEGIN
  SELECT RAISE(ABORT, 'restore records are kept');
END;
