-- Recent reauthentication with MFA proven per session (BYOK design r3, row 4; SEC clear).
-- A credential change needs a fresh WorkOS authentication and then a verified code from the
-- owner's authenticator app: an assurance, bound to that session and organization, used once.
--
-- sessions gains what the sign-in's verified access token said:
-- - authenticated_ms: its auth_time (the most recent active authentication). Fixed: a refresh
--   never changes it, and a new authentication is a new session.
-- - workos_sid: its WorkOS session id, as the latest verified token says (a refresh may
--   change it; an assurance bound to the old one then no longer matches).
-- - impersonated: whether the authentication carried WorkOS's impersonator. It only ever rises.
-- Null in all three (a session made before this, or by the tests) never passes a check.
--
-- credential_assurances: one verified code, for one session, organization and factor, alive at
-- most 300 s from the authentication and from its creation, used at most once. Nothing on a
-- row changes but its use. No impersonated assurance can exist.
--
-- credential_check_quota: the organization's reservations of provider checks and code
-- verifications, in fixed one-hour windows, at most 10 each. A reservation is never released.
-- Text bounds count stored bytes and refuse a NUL, as in 0012, 0014 and 0016.

ALTER TABLE sessions ADD COLUMN authenticated_ms INTEGER
  CHECK (authenticated_ms IS NULL OR authenticated_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE sessions ADD COLUMN workos_sid TEXT
  CHECK (workos_sid IS NULL OR (length(CAST(workos_sid AS BLOB)) BETWEEN 9 AND 128 AND length(workos_sid) = length(CAST(workos_sid AS BLOB)) AND substr(workos_sid, 1, 8) = 'session_' AND substr(workos_sid, 9) NOT GLOB '*[^A-Za-z0-9]*'));
ALTER TABLE sessions ADD COLUMN impersonated INTEGER
  CHECK (impersonated IS NULL OR impersonated IN (0, 1));

CREATE TRIGGER sessions_authenticated_fixed BEFORE UPDATE OF authenticated_ms ON sessions
WHEN NEW.authenticated_ms IS NOT OLD.authenticated_ms
BEGIN
  SELECT RAISE(ABORT, 'a session''s authentication time is fixed');
END;

CREATE TRIGGER sessions_impersonated_rises BEFORE UPDATE OF impersonated ON sessions
WHEN NEW.impersonated IS NOT OLD.impersonated AND NEW.impersonated IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'a session''s impersonation only ever rises');
END;

CREATE TABLE credential_assurances (
  id INTEGER PRIMARY KEY,
  -- the session (its id's hash), and its WorkOS session id when the code was verified
  session_sha256 TEXT NOT NULL CHECK (length(CAST(session_sha256 AS BLOB)) = 64 AND length(session_sha256) = 64 AND session_sha256 NOT GLOB '*[^0-9a-f]*'),
  workos_sid TEXT NOT NULL CHECK (length(CAST(workos_sid AS BLOB)) BETWEEN 9 AND 128 AND length(workos_sid) = length(CAST(workos_sid AS BLOB)) AND substr(workos_sid, 1, 8) = 'session_' AND substr(workos_sid, 9) NOT GLOB '*[^A-Za-z0-9]*'),
  user_id TEXT NOT NULL REFERENCES users (id),
  org_id TEXT NOT NULL REFERENCES orgs (id),
  -- the WorkOS factor the code was verified against
  factor_id TEXT NOT NULL CHECK (length(CAST(factor_id AS BLOB)) BETWEEN 13 AND 128 AND length(factor_id) = length(CAST(factor_id AS BLOB)) AND substr(factor_id, 1, 12) = 'auth_factor_' AND substr(factor_id, 13) NOT GLOB '*[^A-Za-z0-9]*'),
  -- the session's authentication time, and the deployment's environment and client
  auth_time_ms INTEGER NOT NULL CHECK (auth_time_ms BETWEEN 0 AND 9007199254740991),
  env TEXT NOT NULL CHECK (length(CAST(env AS BLOB)) BETWEEN 1 AND 256 AND length(env) = length(CAST(env AS BLOB)) AND env NOT GLOB '*[^!-~]*'),
  client_id TEXT NOT NULL CHECK (length(CAST(client_id AS BLOB)) BETWEEN 8 AND 107 AND length(client_id) = length(CAST(client_id AS BLOB)) AND substr(client_id, 1, 7) = 'client_' AND substr(client_id, 8) NOT GLOB '*[^A-Za-z0-9]*'),
  impersonated INTEGER NOT NULL CHECK (impersonated = 0),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  -- alive through expires_ms: 300 s from the authentication and from the verification, whichever ends first
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  used_ms INTEGER CHECK (used_ms IS NULL OR used_ms BETWEEN 0 AND 9007199254740991),
  CHECK (expires_ms = min(auth_time_ms + 300000, created_ms + 300000)),
  CHECK (expires_ms > created_ms),
  CHECK (used_ms IS NULL OR (used_ms >= created_ms AND used_ms <= expires_ms))
) STRICT;
CREATE INDEX credential_assurances_live ON credential_assurances (session_sha256, org_id, expires_ms) WHERE used_ms IS NULL;

CREATE TRIGGER credential_assurances_fixed BEFORE UPDATE ON credential_assurances
WHEN NEW.id IS NOT OLD.id OR NEW.session_sha256 IS NOT OLD.session_sha256 OR NEW.workos_sid IS NOT OLD.workos_sid
  OR NEW.user_id IS NOT OLD.user_id OR NEW.org_id IS NOT OLD.org_id OR NEW.factor_id IS NOT OLD.factor_id
  OR NEW.auth_time_ms IS NOT OLD.auth_time_ms OR NEW.env IS NOT OLD.env OR NEW.client_id IS NOT OLD.client_id
  OR NEW.impersonated IS NOT OLD.impersonated OR NEW.created_ms IS NOT OLD.created_ms OR NEW.expires_ms IS NOT OLD.expires_ms
BEGIN
  SELECT RAISE(ABORT, 'an assurance changes only by its use');
END;

CREATE TRIGGER credential_assurances_used_once BEFORE UPDATE OF used_ms ON credential_assurances
WHEN OLD.used_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an assurance is used once');
END;

CREATE TABLE credential_check_quota (
  org_id TEXT NOT NULL REFERENCES orgs (id),
  -- the window's start: a whole hour
  window_start_ms INTEGER NOT NULL CHECK (window_start_ms BETWEEN 0 AND 9007199254740991 AND window_start_ms % 3600000 = 0),
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 10),
  PRIMARY KEY (org_id, window_start_ms)
) STRICT;

CREATE TRIGGER credential_check_quota_rises BEFORE UPDATE ON credential_check_quota
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.window_start_ms IS NOT OLD.window_start_ms OR NEW.used IS NOT OLD.used + 1
BEGIN
  SELECT RAISE(ABORT, 'a check reservation is only ever added, one at a time');
END;

CREATE TRIGGER credential_check_quota_kept BEFORE DELETE ON credential_check_quota
BEGIN
  SELECT RAISE(ABORT, 'a check reservation is never released');
END;
