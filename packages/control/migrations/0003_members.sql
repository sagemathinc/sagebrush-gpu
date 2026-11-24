-- Invariants of members and allocations, enforced by the database so that no ordering of
-- concurrent requests can break them. A member's allocation is the allocations row with
-- holder_kind = 'member' and holder_id = the member's id.

-- A project's allocations never add up to more than its budget.
CREATE TRIGGER allocations_within_budget_insert AFTER INSERT ON allocations
WHEN (SELECT COALESCE(SUM(amount), 0) FROM allocations WHERE project_id = NEW.project_id)
   > (SELECT budget FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'over-allocation: allocations would exceed the project budget');
END;

CREATE TRIGGER allocations_within_budget_update AFTER UPDATE OF amount, project_id ON allocations
WHEN (SELECT COALESCE(SUM(amount), 0) FROM allocations WHERE project_id = NEW.project_id)
   > (SELECT budget FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'over-allocation: allocations would exceed the project budget');
END;

CREATE TRIGGER projects_budget_covers_allocations AFTER UPDATE OF budget ON projects
WHEN NEW.budget < (SELECT COALESCE(SUM(amount), 0) FROM allocations WHERE project_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'over-allocation: the budget would be below its allocations');
END;

-- A project with an active owner always keeps one: the last active owner can be neither
-- demoted nor removed.
CREATE TRIGGER members_keep_an_owner BEFORE UPDATE OF role, status ON members
WHEN OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND NOT EXISTS (
    SELECT 1 FROM members m
    WHERE m.project_id = OLD.project_id AND m.role = 'owner' AND m.status = 'active' AND m.id <> OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'last-owner: a project keeps at least one active owner');
END;

-- Members are removed by status, never deleted: their spend stays attributed.
CREATE TRIGGER members_kept BEFORE DELETE ON members
BEGIN
  SELECT RAISE(ABORT, 'members are never deleted');
END;

-- A member may not move to another project or email.
CREATE TRIGGER members_identity_fixed BEFORE UPDATE OF project_id, email ON members
WHEN NEW.project_id <> OLD.project_id OR NEW.email <> OLD.email
BEGIN
  SELECT RAISE(ABORT, 'a member keeps its project and email');
END;
