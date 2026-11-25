-- Sign-in through WorkOS AuthKit (src/auth.ts). Who signed in is a WorkOS identity, its
-- (issuer, subject), mapped to one of our users; never an email. A sign-in under way is
-- a one-time state. A session keeps what it needs to be revalidated with WorkOS: its
-- refresh token, sealed, and when it was last validated.

CREATE TABLE identities (
  iss TEXT NOT NULL CHECK (length(iss) BETWEEN 1 AND 200),
  sub TEXT NOT NULL CHECK (length(sub) BETWEEN 1 AND 200),
  -- one identity per user
  user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
  -- the address WorkOS last said is verified, and the ticket (the time its request was
  -- made) that orders updates, so a late answer can't overwrite a newer one
  email TEXT CHECK (email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 320)),
  email_ticket INTEGER NOT NULL CHECK (email_ticket BETWEEN 0 AND 9007199254740991),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (iss, sub)
) STRICT;

-- A sign-in's nonce, spent once (its hash), until it expires; bounded where it's spent.
CREATE TABLE auth_states (
  nonce_sha256 TEXT PRIMARY KEY CHECK (length(nonce_sha256) = 64),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX auth_states_by_expiry ON auth_states (expires_ms);

-- A session from a WorkOS sign-in: its refresh token sealed (version and ciphertext), when
-- WorkOS last validated it, and a claim so only one request refreshes it at a time.
ALTER TABLE sessions ADD COLUMN refresh_version TEXT
  CHECK (refresh_version IS NULL OR length(refresh_version) BETWEEN 1 AND 16);
ALTER TABLE sessions ADD COLUMN refresh_sealed TEXT
  CHECK (refresh_sealed IS NULL OR length(refresh_sealed) BETWEEN 1 AND 16384);
-- (all three or none: a session without them was made before WorkOS or by the tests, and
-- nothing in the app makes one now)
ALTER TABLE sessions ADD COLUMN validated_ms INTEGER
  CHECK (validated_ms IS NULL OR validated_ms BETWEEN 0 AND 9007199254740991)
  CHECK ((validated_ms IS NULL) = (refresh_sealed IS NULL) AND (refresh_sealed IS NULL) = (refresh_version IS NULL));
ALTER TABLE sessions ADD COLUMN refresh_claim_ms INTEGER
  CHECK (refresh_claim_ms IS NULL OR refresh_claim_ms BETWEEN 0 AND 9007199254740991);
