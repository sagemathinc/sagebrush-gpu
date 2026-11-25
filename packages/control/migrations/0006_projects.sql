-- Organizations' credit, and projects' policy and display labels.
--
-- Credit: an organization buys credit (an invoice or purchase order: operators only),
-- holds it unassigned, and moves it to and from its projects' budgets. Every movement
-- is a credit_events row, written in the same batch as the balances it changes, so
-- total_credit = unassigned_credit + the sum of its projects' budgets after every
-- movement made this way. Balances can never go below zero.
--
-- Projects funded before this migration get opening balances (below): each organization's
-- total credit becomes the sum of its projects' budgets, none of it unassigned. If that sum
-- would pass the safe range for any organization, this first statement fails, before any
-- other statement here has run, so the database is left as it was (the migration doesn't
-- rely on being applied as one transaction). json() of text that isn't JSON is the error;
-- a SUM past 2^63 fails here too, with SQLite's own integer overflow.
SELECT CASE
  WHEN (SELECT MAX(s) FROM (SELECT SUM(budget) AS s FROM projects GROUP BY org_id)) > 9007199254740991
  THEN json('refused: an organization''s project budgets add up past the safe range')
END;

ALTER TABLE orgs ADD COLUMN unassigned_credit INTEGER NOT NULL DEFAULT 0
  CHECK (unassigned_credit BETWEEN 0 AND 9007199254740991);
ALTER TABLE orgs ADD COLUMN total_credit INTEGER NOT NULL DEFAULT 0
  CHECK (total_credit BETWEEN 0 AND 9007199254740991);

-- The policy as JSON: the fields that differ from the defaults (finalSaveReserveMinutes
-- lives in its own column, which the ledger reads). Validated by the contract's
-- validatePolicyPatch before it is written; bounded here in size.
ALTER TABLE projects ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(policy_json) AND json_type(policy_json) = 'object' AND length(policy_json) <= 65536);
ALTER TABLE projects ADD COLUMN labels_json TEXT
  CHECK (labels_json IS NULL OR (json_valid(labels_json) AND json_type(labels_json) = 'object' AND length(labels_json) <= 4096));

CREATE TABLE credit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  kind TEXT NOT NULL CHECK (kind IN ('credit', 'to_project', 'from_project')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
  project_id TEXT,
  reference TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 200),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  -- a credit names its invoice or order and no project; a move names its project
  CHECK ((kind = 'credit') = (project_id IS NULL)),
  CHECK ((kind = 'credit') = (reference IS NOT NULL)),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) STRICT;
CREATE INDEX credit_events_by_org ON credit_events (org_id, created_ms);

-- Opening balances, with their history: one opening credit per organization with funded
-- projects (named as such), then one move to each funded project, so replaying the events
-- gives every balance. Ids are derived from the org's or project's own (same alphabet and
-- length), and times from the projects' creation: no clock or randomness needed.
INSERT INTO credit_events (id, org_id, kind, amount, project_id, reference, created_ms)
  SELECT 'cre_' || substr(org_id, 5), org_id, 'credit', SUM(budget), NULL, 'opening balance: project budgets before credit accounting', MIN(created_ms)
  FROM projects WHERE budget > 0 GROUP BY org_id;
INSERT INTO credit_events (id, org_id, kind, amount, project_id, reference, created_ms)
  SELECT 'cre_' || substr(id, 5), org_id, 'to_project', budget, id, NULL, created_ms
  FROM projects WHERE budget > 0;
UPDATE orgs SET total_credit = (SELECT COALESCE(SUM(budget), 0) FROM projects WHERE org_id = orgs.id);

CREATE TRIGGER credit_events_immutable BEFORE UPDATE ON credit_events
BEGIN
  SELECT RAISE(ABORT, 'credit events are never updated');
END;

CREATE TRIGGER credit_events_kept BEFORE DELETE ON credit_events
BEGIN
  SELECT RAISE(ABORT, 'credit events are never deleted');
END;
