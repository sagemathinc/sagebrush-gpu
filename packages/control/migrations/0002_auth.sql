-- People and sign-in. Emails are stored lowercased. Sign-in link tokens and session ids
-- are never stored: only their SHA-256 (lowercase hex). STRICT tables, safe-integer times.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'owner')),
  PRIMARY KEY (org_id, user_id)
) STRICT;

-- A person in a project. Invited by email; user_id is set when they first sign in.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  user_id TEXT REFERENCES users (id),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('member', 'assistant', 'manager', 'owner')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
  team_id TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (project_id, email),
  CHECK (status <> 'active' OR user_id IS NOT NULL)
) STRICT;
CREATE INDEX members_by_user ON members (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX members_by_email ON members (email);

CREATE TABLE sign_in_links (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64),
  email TEXT NOT NULL CHECK (email = lower(email)),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  used_ms INTEGER CHECK (used_ms IS NULL OR used_ms BETWEEN 0 AND 9007199254740991),
  CHECK (expires_ms > created_ms)
) STRICT;
CREATE INDEX sign_in_links_by_email ON sign_in_links (email, created_ms);

CREATE TABLE sessions (
  id_sha256 TEXT PRIMARY KEY CHECK (length(id_sha256) = 64),
  user_id TEXT NOT NULL REFERENCES users (id),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  expires_ms INTEGER NOT NULL CHECK (expires_ms BETWEEN 0 AND 9007199254740991),
  revoked_ms INTEGER CHECK (revoked_ms IS NULL OR revoked_ms BETWEEN 0 AND 9007199254740991),
  CHECK (expires_ms > created_ms)
) STRICT;
CREATE INDEX sessions_by_user ON sessions (user_id);
