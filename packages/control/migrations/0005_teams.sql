-- Teams: groups of a project's members with a shared allocation (holder_kind = 'team',
-- holder_id = the team's id). A team is deleted softly: it stays on record, with its
-- allocation and spend, but no member belongs to it any more.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND name = trim(name)),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  deleted_ms INTEGER CHECK (deleted_ms IS NULL OR deleted_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (id, project_id)
) STRICT;

-- Names are unique among a project's live teams (case-insensitively).
CREATE UNIQUE INDEX teams_live_name ON teams (project_id, lower(name)) WHERE deleted_ms IS NULL;

-- A member's team is a live team of the member's own project.
CREATE TRIGGER members_team_live_insert BEFORE INSERT ON members
WHEN NEW.team_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.id = NEW.team_id AND t.project_id = NEW.project_id AND t.deleted_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'team: a member''s team must be a live team of its project');
END;

CREATE TRIGGER members_team_live_update BEFORE UPDATE OF team_id ON members
WHEN NEW.team_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.id = NEW.team_id AND t.project_id = NEW.project_id AND t.deleted_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'team: a member''s team must be a live team of its project');
END;

-- A deleted team has no members.
CREATE TRIGGER teams_delete_empty AFTER UPDATE OF deleted_ms ON teams
WHEN NEW.deleted_ms IS NOT NULL AND EXISTS (SELECT 1 FROM members m WHERE m.team_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'team: a deleted team keeps no members');
END;

-- A team keeps its project, is deleted at most once, and never comes back.
CREATE TRIGGER teams_identity_fixed BEFORE UPDATE OF project_id, deleted_ms ON teams
WHEN NEW.project_id <> OLD.project_id OR (OLD.deleted_ms IS NOT NULL AND NEW.deleted_ms IS NOT OLD.deleted_ms)
BEGIN
  SELECT RAISE(ABORT, 'team: a team keeps its project and stays deleted');
END;

CREATE TRIGGER teams_kept BEFORE DELETE ON teams
BEGIN
  SELECT RAISE(ABORT, 'teams are never deleted');
END;

-- At most 200 live teams per project.
CREATE TRIGGER teams_cap BEFORE INSERT ON teams
WHEN (SELECT COUNT(*) FROM teams WHERE project_id = NEW.project_id AND deleted_ms IS NULL) >= 200
BEGIN
  SELECT RAISE(ABORT, 'team-cap: a project has at most 200 teams');
END;
