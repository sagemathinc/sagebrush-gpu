-- GPU billing d4 step 2 (TEST mode first): an organization (a course) prepays credit through Stripe, by
-- invoice (ACH or wire) or by card, and the credit lands in 0006's org balances. Append-only, as 0022:
-- triggers refuse every UPDATE and DELETE, and every unique key has a BEFORE INSERT guard (REPLACE would
-- delete the kept row without firing BEFORE DELETE).
--
-- - Whose: an org's Stripe Customer, one per org (A3), never an individual's (N3, per org).
-- - What is credited: always net of payment fees (William, Nov 27). A credit row's amount is exactly what
--   its balance transactions netted (each kept once, by its txn_ id, across every invoice: SEC I6), less
--   the invoice's course-fee lines (d4.1); the database checks the sum.
-- - The credit itself is 0006's credit_events row, reference 'stripe:<key>', with the org's unassigned and
--   total credit raised by the same amount, in the same batch. A 'stripe:' credit needs its org_payments
--   row, for the same org and the same amount (D4, P2); a 'manual:' credit is refused until d4.6's manual
--   credits exist (that migration replaces the trigger); and each such reference credits once.
--
-- All or nothing, as 0006: the guard is the only statement whose success depends on the data, and it runs
-- first. Credit references were free text written by operators; none may already use the reserved forms.
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM credit_events WHERE lower(substr(reference, 1, 7)) IN ('stripe:', 'manual:'))
  THEN json('refused: a credit reference already uses a reserved prefix (stripe: or manual:)')
END;

CREATE TABLE stripe_org_customers (
  org_id TEXT PRIMARY KEY REFERENCES orgs (id),
  customer_id TEXT NOT NULL UNIQUE
    CHECK (length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id, 1, 4) = 'cus_' AND substr(customer_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

-- One row per Stripe object, by (kind, stripe_key):
-- - card_credit: a card top-up's PaymentIntent (pi_): gross paid, Stripe's fee, credit = gross - fee;
-- - invoice_credit: a paid invoice (in_): gross = its payments less its course-fee lines (the deposits),
--   fee = the payments' processing fees, credit = gross - fee;
-- - fee: an invoice's course-fee lines (in_), recorded and never credit (gross = the fee, credit 0);
-- - pending: the marker for an object whose fees weren't known yet (d3 T1, d4.1); only such an object may
--   be credited later (via 'later').
CREATE TABLE org_payments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  kind TEXT NOT NULL CHECK (kind IN ('card_credit', 'invoice_credit', 'fee', 'pending')),
  stripe_key TEXT NOT NULL CHECK (length(stripe_key) BETWEEN 4 AND 255 AND stripe_key NOT GLOB '*[^A-Za-z0-9_]*'),
  gross INTEGER CHECK (gross IS NULL OR gross BETWEEN 1 AND 9007199254740991),
  fee INTEGER CHECK (fee IS NULL OR fee BETWEEN 0 AND 9007199254740991),
  credit INTEGER NOT NULL CHECK (credit BETWEEN 0 AND 9007199254740991),
  -- how a credit arrived: from its own event (checkout completed, invoice paid), or later for a pending marker
  via TEXT CHECK (via IS NULL OR via IN ('event', 'later')),
  event_id TEXT REFERENCES stripe_events (event_id),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (kind, stripe_key),
  CHECK (kind NOT IN ('card_credit', 'invoice_credit') OR (gross IS NOT NULL AND fee IS NOT NULL AND fee < gross AND credit = gross - fee AND via IS NOT NULL)),
  CHECK (kind IN ('card_credit', 'invoice_credit') OR via IS NULL),
  CHECK (kind <> 'card_credit' OR substr(stripe_key, 1, 3) = 'pi_'),
  CHECK (kind <> 'invoice_credit' OR substr(stripe_key, 1, 3) = 'in_'),
  CHECK (kind <> 'fee' OR (substr(stripe_key, 1, 3) = 'in_' AND gross IS NOT NULL AND fee IS NULL AND credit = 0)),
  CHECK (kind <> 'pending' OR (substr(stripe_key, 1, 3) IN ('pi_', 'in_') AND gross IS NULL AND fee IS NULL AND credit = 0))
) STRICT;
CREATE INDEX org_payments_by_org ON org_payments (org_id, seq);

-- Each balance transaction (txn_) that funded a credit, once across every invoice and top-up (SEC I6): its
-- amount and fee as Stripe states them, and the object it was applied to.
CREATE TABLE org_payment_txns (
  txn_id TEXT PRIMARY KEY
    CHECK (length(txn_id) BETWEEN 5 AND 255 AND substr(txn_id, 1, 4) = 'txn_' AND substr(txn_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  org_id TEXT NOT NULL REFERENCES orgs (id),
  stripe_key TEXT NOT NULL CHECK (length(stripe_key) BETWEEN 4 AND 255 AND substr(stripe_key, 1, 3) IN ('pi_', 'in_') AND stripe_key NOT GLOB '*[^A-Za-z0-9_]*'),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
  fee INTEGER NOT NULL CHECK (fee BETWEEN 0 AND 9007199254740991),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  CHECK (fee <= amount)
) STRICT;
CREATE INDEX org_payment_txns_by_key ON org_payment_txns (stripe_key);

-- An individual's Customer and an org's are kept apart, so a person's top-up never lands on an org, nor
-- the reverse (A3, N3).
CREATE TRIGGER stripe_org_customers_apart BEFORE INSERT ON stripe_org_customers
WHEN EXISTS (SELECT 1 FROM stripe_customers WHERE customer_id = NEW.customer_id)
BEGIN SELECT RAISE(ABORT, 'that Customer is a person''s, not an organization''s'); END;
CREATE TRIGGER stripe_customers_apart BEFORE INSERT ON stripe_customers
WHEN EXISTS (SELECT 1 FROM stripe_org_customers WHERE customer_id = NEW.customer_id)
BEGIN SELECT RAISE(ABORT, 'that Customer is an organization''s, not a person''s'); END;

-- A credit is exactly what its balance transactions netted, less the invoice's course-fee row, all written
-- earlier in its batch; a later credit needs its pending marker (d3.2's rule, per org).
CREATE TRIGGER org_payments_credit_is_net BEFORE INSERT ON org_payments
WHEN NEW.kind IN ('card_credit', 'invoice_credit')
  AND NOT EXISTS (SELECT 1 FROM org_payments WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key)
  AND (
    COALESCE((SELECT SUM(amount - fee) FROM org_payment_txns WHERE stripe_key = NEW.stripe_key AND org_id = NEW.org_id), -1)
      <> NEW.credit + COALESCE((SELECT gross FROM org_payments WHERE kind = 'fee' AND stripe_key = NEW.stripe_key AND org_id = NEW.org_id), 0)
    OR COALESCE((SELECT SUM(fee) FROM org_payment_txns WHERE stripe_key = NEW.stripe_key AND org_id = NEW.org_id), -1) <> NEW.fee
    OR EXISTS (SELECT 1 FROM org_payment_txns WHERE stripe_key = NEW.stripe_key AND org_id <> NEW.org_id))
BEGIN SELECT RAISE(ABORT, 'a credit must be exactly its balance transactions'' net, less its course fee'); END;
CREATE TRIGGER org_payments_later_needs_marker BEFORE INSERT ON org_payments
WHEN NEW.via = 'later'
  AND NOT EXISTS (SELECT 1 FROM org_payments WHERE kind = 'pending' AND stripe_key = NEW.stripe_key AND org_id = NEW.org_id)
BEGIN SELECT RAISE(ABORT, 'a later credit needs its pending marker'); END;
-- A credited payment's transactions are closed (TESTS H1 on #125): only an exact replay of one already kept
-- may meet its key again, so no later write can attach another balance transaction to it (which would break
-- the net it was credited at, and spend a transaction that belongs to another payment).
CREATE TRIGGER org_payment_txns_closed_once_credited BEFORE INSERT ON org_payment_txns
WHEN NOT EXISTS (SELECT 1 FROM org_payment_txns WHERE txn_id = NEW.txn_id)
  AND EXISTS (SELECT 1 FROM org_payments WHERE kind IN ('card_credit', 'invoice_credit') AND stripe_key = NEW.stripe_key)
BEGIN SELECT RAISE(ABORT, 'a credited payment''s balance transactions are closed'); END;
-- A course fee belongs to an invoice that is not yet credited (the credit reads it).
CREATE TRIGGER org_payments_fee_before_credit BEFORE INSERT ON org_payments
WHEN NEW.kind = 'fee'
  AND NOT EXISTS (SELECT 1 FROM org_payments WHERE kind = 'fee' AND stripe_key = NEW.stripe_key)
  AND EXISTS (SELECT 1 FROM org_payments WHERE kind = 'invoice_credit' AND stripe_key = NEW.stripe_key)
BEGIN SELECT RAISE(ABORT, 'an invoice''s course fee comes before its credit'); END;

-- The same row again (a replay) is dropped; anything else meeting a kept key is refused.
CREATE TRIGGER stripe_org_customers_replay BEFORE INSERT ON stripe_org_customers
WHEN EXISTS (SELECT 1 FROM stripe_org_customers WHERE org_id = NEW.org_id AND customer_id = NEW.customer_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER stripe_org_customers_conflict BEFORE INSERT ON stripe_org_customers
WHEN EXISTS (SELECT 1 FROM stripe_org_customers WHERE (org_id = NEW.org_id) <> (customer_id = NEW.customer_id)
  AND (org_id = NEW.org_id OR customer_id = NEW.customer_id))
BEGIN SELECT RAISE(ABORT, 'that Customer belongs to another organization, or the organization has another Customer'); END;
CREATE TRIGGER org_payments_replay BEFORE INSERT ON org_payments
WHEN (NEW.seq IS NULL OR NOT EXISTS (SELECT 1 FROM org_payments WHERE seq = NEW.seq))
  AND EXISTS (SELECT 1 FROM org_payments WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key
    AND org_id = NEW.org_id AND gross IS NEW.gross AND fee IS NEW.fee AND credit = NEW.credit)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER org_payments_conflict BEFORE INSERT ON org_payments
WHEN (NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM org_payments WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM org_payments WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key
    AND NOT (org_id = NEW.org_id AND gross IS NEW.gross AND fee IS NEW.fee AND credit = NEW.credit))
BEGIN SELECT RAISE(ABORT, 'an org payment is never replaced'); END;
CREATE TRIGGER org_payment_txns_replay BEFORE INSERT ON org_payment_txns
WHEN EXISTS (SELECT 1 FROM org_payment_txns WHERE txn_id = NEW.txn_id
  AND org_id = NEW.org_id AND stripe_key = NEW.stripe_key AND amount = NEW.amount AND fee = NEW.fee)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER org_payment_txns_conflict BEFORE INSERT ON org_payment_txns
WHEN EXISTS (SELECT 1 FROM org_payment_txns WHERE txn_id = NEW.txn_id
  AND NOT (org_id = NEW.org_id AND stripe_key = NEW.stripe_key AND amount = NEW.amount AND fee = NEW.fee))
BEGIN SELECT RAISE(ABORT, 'a balance transaction funds one credit, once'); END;

CREATE TRIGGER stripe_org_customers_immutable BEFORE UPDATE ON stripe_org_customers BEGIN SELECT RAISE(ABORT, 'org customers are never updated'); END;
CREATE TRIGGER stripe_org_customers_kept BEFORE DELETE ON stripe_org_customers BEGIN SELECT RAISE(ABORT, 'org customers are never deleted'); END;
CREATE TRIGGER org_payments_immutable BEFORE UPDATE ON org_payments BEGIN SELECT RAISE(ABORT, 'org payments are never updated'); END;
CREATE TRIGGER org_payments_kept BEFORE DELETE ON org_payments BEGIN SELECT RAISE(ABORT, 'org payments are never deleted'); END;
CREATE TRIGGER org_payment_txns_immutable BEFORE UPDATE ON org_payment_txns BEGIN SELECT RAISE(ABORT, 'payment transactions are never updated'); END;
CREATE TRIGGER org_payment_txns_kept BEFORE DELETE ON org_payment_txns BEGIN SELECT RAISE(ABORT, 'payment transactions are never deleted'); END;

-- 0006's credit_events: never replaced (by id, or by a reserved reference), and a reserved reference only
-- as its backing row allows. The prefixes are reserved whatever their case, and allowed only exactly.
CREATE UNIQUE INDEX credit_events_by_reserved_reference ON credit_events (reference)
  WHERE substr(reference, 1, 7) IN ('stripe:', 'manual:');
CREATE TRIGGER credit_events_never_replaced BEFORE INSERT ON credit_events
WHEN EXISTS (SELECT 1 FROM credit_events WHERE id = NEW.id)
  OR (substr(NEW.reference, 1, 7) IN ('stripe:', 'manual:') AND EXISTS (SELECT 1 FROM credit_events WHERE reference = NEW.reference))
BEGIN SELECT RAISE(ABORT, 'a credit event is never replaced, and a Stripe or manual reference credits once'); END;
CREATE TRIGGER credit_events_reserved_reference BEFORE INSERT ON credit_events
WHEN lower(substr(NEW.reference, 1, 7)) IN ('stripe:', 'manual:')
  AND NOT (
    substr(NEW.reference, 1, 7) = 'stripe:' AND NEW.kind = 'credit'
    AND EXISTS (SELECT 1 FROM org_payments p WHERE p.kind IN ('card_credit', 'invoice_credit')
      AND p.stripe_key = substr(NEW.reference, 8) AND p.org_id = NEW.org_id AND p.credit = NEW.amount))
BEGIN SELECT RAISE(ABORT, 'a stripe: credit needs its org payment, for the same organization and amount; manual: credits come with d4.6'); END;
