-- An allocation is never deleted (#118 SEC note). 0023 keeps its amount from going below what it has spent
-- or while it's encumbered; deleting the row would free that credit just the same, and nothing in control
-- deletes one (a team's deletion lowers its allocation instead). So a delete is refused outright, by any
-- writer.
CREATE TRIGGER allocations_kept BEFORE DELETE ON allocations
BEGIN
  SELECT RAISE(ABORT, 'committed: an allocation is never deleted');
END;
