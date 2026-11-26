-- An organization's own provider keys (billing mode 'byok'), sealed (BYOK design r3, row 2;
-- SEC clear). One row per (organization, provider): the key sealed with AES-256-GCM under a
-- Worker secret (the KEK, never in this database), bound by its associated data to the
-- environment, the organization, the provider, the row's id and version and the KEK's version.
-- The key itself is never stored, nor anything built from it but its sealed form and a
-- fingerprint (a truncated HMAC under a separate secret).
-- - Only a byok organization holds a key (an insert trigger): a resold one never does.
-- - A row's id, organization and provider are fixed. A replace moves the version up by
--   exactly 1; a re-seal under a newer KEK and a recorded check keep it, and keep the
--   fingerprint and who set the key, when. A new seal always has a new nonce.
-- - Removal deletes the row (break-glass, at once), with a 'remove' event in the same batch.
-- credential_events is the history: append-only (never changed or deleted), and never the key
-- or its ciphertext. Text bounds count stored bytes and refuse a NUL, as in 0012 and 0014
-- (every bounded text here is ASCII by its pattern, so its characters are its bytes).

CREATE TABLE provider_credentials (
  -- 'crd_' and 20 lowercase base-32 characters
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 24 AND length(id) = 24 AND substr(id, 1, 4) = 'crd_' AND substr(id, 5) NOT GLOB '*[^0-9abcdefghjkmnpqrstvwxyz]*'),
  org_id TEXT NOT NULL REFERENCES orgs (id),
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  -- 1 at the set; up by exactly 1 at each replace
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  -- base64 of the ciphertext and its 16-byte tag: a key is 1 to 4096 bytes, so 17 to 4112
  -- bytes, 24 to 5484 characters
  sealed TEXT NOT NULL CHECK (length(CAST(sealed AS BLOB)) BETWEEN 24 AND 5484 AND length(sealed) = length(CAST(sealed AS BLOB)) AND sealed NOT GLOB '*[^A-Za-z0-9+/=]*'),
  -- base64 of the 96-bit nonce
  nonce TEXT NOT NULL CHECK (length(CAST(nonce AS BLOB)) = 16 AND length(nonce) = 16 AND nonce NOT GLOB '*[^A-Za-z0-9+/]*'),
  -- the KEK's version (CREDENTIAL_KEKS's entry it was sealed under)
  kek_version TEXT NOT NULL CHECK (length(CAST(kek_version AS BLOB)) BETWEEN 1 AND 16 AND length(kek_version) = length(CAST(kek_version AS BLOB)) AND kek_version NOT GLOB '*[^A-Za-z0-9_-]*'),
  -- 16 lowercase hex characters
  fingerprint TEXT NOT NULL CHECK (length(CAST(fingerprint AS BLOB)) = 16 AND length(fingerprint) = 16 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('unchecked', 'ok', 'rejected', 'revoked', 'error')),
  -- when a check last recorded the status: null exactly while unchecked
  last_checked_ms INTEGER CHECK (last_checked_ms IS NULL OR last_checked_ms BETWEEN 0 AND 9007199254740991),
  -- the owner who set this version, and when
  set_by TEXT NOT NULL REFERENCES users (id),
  set_ms INTEGER NOT NULL CHECK (set_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (org_id, provider),
  CHECK ((status = 'unchecked') = (last_checked_ms IS NULL))
) STRICT;

CREATE TRIGGER provider_credentials_byok_only BEFORE INSERT ON provider_credentials
WHEN (SELECT billing_mode FROM orgs WHERE id = NEW.org_id) IS NOT 'byok'
BEGIN
  SELECT RAISE(ABORT, 'only a byok organization holds a provider key');
END;

CREATE TRIGGER provider_credentials_identity_fixed BEFORE UPDATE OF id, org_id, provider ON provider_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.provider IS NOT OLD.provider
BEGIN
  SELECT RAISE(ABORT, 'a provider key''s id, organization and provider are fixed');
END;

CREATE TRIGGER provider_credentials_version_step BEFORE UPDATE OF version ON provider_credentials
WHEN NEW.version IS NOT OLD.version AND NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'a provider key''s version only moves up by 1');
END;

-- the same version is the same key: a re-seal or a check never changes its fingerprint, or who
-- set it, when
CREATE TRIGGER provider_credentials_same_version_same_key BEFORE UPDATE ON provider_credentials
WHEN NEW.version = OLD.version
  AND (NEW.fingerprint IS NOT OLD.fingerprint OR NEW.set_by IS NOT OLD.set_by OR NEW.set_ms IS NOT OLD.set_ms)
BEGIN
  SELECT RAISE(ABORT, 'the same version of a provider key keeps its fingerprint and setter');
END;

CREATE TRIGGER provider_credentials_fresh_nonce BEFORE UPDATE OF sealed, nonce ON provider_credentials
WHEN NEW.sealed IS NOT OLD.sealed AND NEW.nonce IS OLD.nonce
BEGIN
  SELECT RAISE(ABORT, 'a new seal has a new nonce');
END;

CREATE TABLE credential_events (
  id INTEGER PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  provider TEXT NOT NULL CHECK (provider IN ('runpod', 'shadeform', 'hyperstack', 'nebius')),
  -- the credential row's id and version the event is about (the row may since be gone)
  credential_id TEXT NOT NULL CHECK (length(CAST(credential_id AS BLOB)) = 24 AND length(credential_id) = 24 AND substr(credential_id, 1, 4) = 'crd_' AND substr(credential_id, 5) NOT GLOB '*[^0-9abcdefghjkmnpqrstvwxyz]*'),
  credential_version INTEGER NOT NULL CHECK (credential_version BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('set', 'replace', 'remove', 'check')),
  fingerprint TEXT NOT NULL CHECK (length(CAST(fingerprint AS BLOB)) = 16 AND length(fingerprint) = 16 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  -- a check's result; null for every other kind
  status TEXT CHECK (status IS NULL OR status IN ('ok', 'rejected', 'revoked', 'error')),
  -- the owner who acted; null only for a check (the scheduled one)
  actor TEXT REFERENCES users (id),
  at_ms INTEGER NOT NULL CHECK (at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((kind = 'check') = (status IS NOT NULL)),
  CHECK (kind = 'check' OR actor IS NOT NULL),
  CHECK (kind <> 'set' OR credential_version = 1),
  CHECK (kind <> 'replace' OR credential_version > 1)
) STRICT;
CREATE INDEX credential_events_by_org ON credential_events (org_id, provider, at_ms);

CREATE TRIGGER credential_events_no_update BEFORE UPDATE ON credential_events
BEGIN
  SELECT RAISE(ABORT, 'credential events are never changed');
END;

CREATE TRIGGER credential_events_no_delete BEFORE DELETE ON credential_events
BEGIN
  SELECT RAISE(ABORT, 'credential events are never deleted');
END;
