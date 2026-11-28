-- An operator's credit to an organization (projects.ts addOrgCredit: an invoice, a purchase order, a wire)
-- is keyed by its reference, once per organization (Codex audit G02-2: the same $5,000 credit for the same
-- wire, run twice, gave $10,000 and two events). The same reference again is a replay: addOrgCredit returns
-- the organization as it is and credits nothing; the same reference with another amount is refused.
--
-- The key is the normalized reference (projects.ts normalizeCreditReference: trimmed, every whitespace run
-- collapsed to one space, upper-cased), so the references already stored are normalized here the same way,
-- or ' wire<tab> 7 ' kept as it was would let 'WIRE 7' credit a second time. That's exact for printable ASCII
-- and ASCII whitespace (SQLite's upper is ASCII's, and the five control whitespace characters are turned to
-- spaces before collapsing); a reference with anything else is refused, for a human to decide. References
-- written by code are kept exactly: the reserved prefixes ('stripe:<key>', 0027) and 0006's opening balance.
--
-- All or nothing, as 0006: the guard is the only statement whose success depends on the data, and it runs
-- first. It refuses a database where an operator's credit reference has a character outside printable ASCII
-- and ASCII whitespace or is empty after normalizing, or where one organization would have two credits with
-- one reference (as stored, or once normalized). (Nine passes collapse any whitespace run of up to 512; 0006's
-- check keeps a reference to 200 characters.)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit' AND substr(reference, 1, 7) NOT IN ('stripe:', 'manual:') AND reference <> 'opening balance: project budgets before credit accounting'
    AND reference GLOB '*[^' || char(9) || '-' || char(13) || ' -~]*')
  THEN json('refused: a credit reference has a character outside printable ASCII')
  WHEN EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit' AND substr(reference, 1, 7) NOT IN ('stripe:', 'manual:') AND reference <> 'opening balance: project budgets before credit accounting'
    AND upper(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(reference, char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))) = '')
  THEN json('refused: a credit reference is empty once normalized')
  WHEN EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit'
    GROUP BY org_id, CASE WHEN substr(reference, 1, 7) NOT IN ('stripe:', 'manual:') AND reference <> 'opening balance: project budgets before credit accounting' THEN upper(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(reference, char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))) ELSE reference END HAVING COUNT(*) > 1)
  THEN json('refused: an organization would have two credits with one reference')
END;

-- (0006's credit_events_immutable, lifted for this one normalization and put back as it was)
DROP TRIGGER credit_events_immutable;
UPDATE credit_events SET reference = upper(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(reference, char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')))
  WHERE kind = 'credit' AND substr(reference, 1, 7) NOT IN ('stripe:', 'manual:') AND reference <> 'opening balance: project budgets before credit accounting' AND reference <> upper(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(reference, char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')));
CREATE TRIGGER credit_events_immutable BEFORE UPDATE ON credit_events
BEGIN
  SELECT RAISE(ABORT, 'credit events are never updated');
END;

CREATE UNIQUE INDEX credit_events_by_org_reference ON credit_events (org_id, reference) WHERE kind = 'credit';

-- REPLACE would use that index to delete the kept credit without firing 0006's credit_events_kept, so a
-- credit that meets it is refused before any conflict clause.
CREATE TRIGGER credit_events_reference_once BEFORE INSERT ON credit_events
WHEN NEW.kind = 'credit' AND EXISTS (SELECT 1 FROM credit_events WHERE kind = 'credit' AND org_id = NEW.org_id AND reference = NEW.reference)
BEGIN SELECT RAISE(ABORT, 'a credit reference is used once per organization'); END;
