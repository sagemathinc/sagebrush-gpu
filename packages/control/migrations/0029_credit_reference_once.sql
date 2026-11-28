-- An operator's credit to an organization (projects.ts addOrgCredit: an invoice, a purchase order, a wire)
-- is keyed by its reference, once per organization (Codex audit G02-2: the same $5,000 credit for the same
-- wire, run twice, gave $10,000 and two events). The same reference again is a replay: addOrgCredit returns
-- the organization as it is and credits nothing; the same reference with another amount is refused.
--
-- All or nothing, as 0006: the guard is the only statement whose success depends on the data, and it runs
-- first. A database where one organization already has two credits with one reference is refused, for a human
-- to look at before this applies.
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit' GROUP BY org_id, reference HAVING COUNT(*) > 1)
  THEN json('refused: an organization already has two credits with one reference')
END;

CREATE UNIQUE INDEX credit_events_by_org_reference ON credit_events (org_id, reference) WHERE kind = 'credit';

-- REPLACE would use that index to delete the kept credit without firing 0006's credit_events_kept, so a
-- credit that meets it is refused before any conflict clause.
CREATE TRIGGER credit_events_reference_once BEFORE INSERT ON credit_events
WHEN NEW.kind = 'credit' AND EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit' AND org_id = NEW.org_id AND reference = NEW.reference)
BEGIN SELECT RAISE(ABORT, 'a credit reference is used once per organization'); END;
