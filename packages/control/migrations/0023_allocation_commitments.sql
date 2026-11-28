-- An allocation never gives back money it has already committed (S10-F2). The project's guards (0003)
-- compare only allocation amounts with the budget, and admission subtracts each allocation's own spend
-- from its own amount, so lowering an allocation below what it has spent, or while it still owes for a
-- machine, would free credit that's already consumed or encumbered, for another allocation to spend again.
--
-- So a decrease (a member's or team's new amount, a team's deletion) is refused while the allocation has
-- a machine that may still accrue (starting, running, saving, stopping) or accrued time not yet billed,
-- and it can never go below the allocation's ledger total. With the amounts covering the spend, 0003's
-- triggers keep the budget covering it too, budget returns included. An increase is never refused here.

CREATE TRIGGER allocations_keep_encumbered BEFORE UPDATE OF amount ON allocations
WHEN NEW.amount < OLD.amount AND (
  EXISTS (SELECT 1 FROM machines m WHERE m.allocation_id = OLD.id AND m.state IN ('starting', 'running', 'saving', 'stopping'))
  OR EXISTS (SELECT 1 FROM machine_accruals a JOIN machines m ON m.id = a.machine_id
             WHERE m.allocation_id = OLD.id AND m.billed_through_ms IS NOT NULL AND (a.end_ms IS NULL OR a.end_ms > m.billed_through_ms)))
BEGIN
  SELECT RAISE(ABORT, 'committed: the allocation has machines or unbilled time; stop them before lowering it');
END;

CREATE TRIGGER allocations_keep_spent BEFORE UPDATE OF amount ON allocations
WHEN NEW.amount < OLD.amount AND NEW.amount < (SELECT COALESCE(SUM(e.total), 0) FROM ledger_entries e WHERE e.allocation_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'committed: the allocation would fall below what it has spent');
END;

-- REPLACE deletes the old row and inserts the new one without firing the UPDATE triggers above, so no
-- insert may meet an existing allocation, by either of its keys: an allocation is written once, then only
-- updated (the routes only ever insert new ones).
CREATE TRIGGER allocations_never_replaced BEFORE INSERT ON allocations
WHEN EXISTS (SELECT 1 FROM allocations WHERE id = NEW.id
             OR (project_id = NEW.project_id AND holder_kind = NEW.holder_kind AND holder_id = NEW.holder_id))
BEGIN
  SELECT RAISE(ABORT, 'committed: an allocation is never replaced');
END;
