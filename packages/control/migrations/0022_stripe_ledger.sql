-- GPU billing (design d3.2, TEST mode first): the prepaid balance an individual tops up through
-- Stripe Checkout, their GPU plan, and the records both rest on. All append-only: triggers refuse
-- every UPDATE and DELETE, and the current state is computed from the rows (a balance is a SUM;
-- a plan's or a freeze's state is its latest row).
--
-- Who a Stripe object belongs to comes only from stripe_customers (one Customer per WorkOS
-- identity, N3), never from metadata. Money is integer micro-USD (T5), signed in balance_entries:
-- a dispute can take a balance below zero, which refuses every start (T4).
--
-- One row per Stripe object, by UNIQUE keys, so a replayed or reordered event adds nothing:
-- - topup: one per PaymentIntent, the net (gross minus Stripe's fee) once the fee is known (T1);
-- - pending: the marker for a PaymentIntent whose fee wasn't known at checkout.session.completed;
--   only such a PaymentIntent may be credited later, from charge.updated or a re-fetch (d3.2);
-- - refund: one per refund (re_), from the charge's refunds list (T2);
-- - reversal: one per charge, from a dispute or an early fraud warning, whichever comes first (T3): the
--   charge's net as Stripe states it (amount minus fee), never zero. A topup names its charge and a
--   reversal its PaymentIntent; whichever of the two arrives second must match the first exactly, so the
--   pair sums to zero in either order;
-- - restore: one per charge, a dispute won, exactly the reversal (T4);
-- - won: a dispute on the charge closed as won, no amount, kept so a reversal that arrives after the
--   win is restored in its own batch;
-- - signal: a later dispute or warning on a reversed charge, no amount, once per event.

CREATE TABLE stripe_customers (
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  customer_id TEXT NOT NULL UNIQUE
    CHECK (length(customer_id) BETWEEN 5 AND 255 AND substr(customer_id, 1, 4) = 'cus_' AND substr(customer_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (iss, sub),
  FOREIGN KEY (iss, sub) REFERENCES identities (iss, sub)
) STRICT;

-- Each verified event, once: a delivery replayed inside the signature's window is seen here.
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY
    CHECK (length(event_id) BETWEEN 5 AND 255 AND substr(event_id, 1, 4) = 'evt_' AND substr(event_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 100 AND type NOT GLOB '*[^a-z_.]*'),
  received_ms INTEGER NOT NULL CHECK (received_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE balance_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'pending', 'refund', 'reversal', 'restore', 'won', 'signal')),
  -- the Stripe object the row is about: a PaymentIntent (topup, pending), a refund, a charge
  -- (reversal, restore) or the event (signal)
  stripe_key TEXT NOT NULL CHECK (length(stripe_key) BETWEEN 4 AND 255 AND stripe_key NOT GLOB '*[^A-Za-z0-9_]*'),
  amount INTEGER NOT NULL CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991),
  -- a topup's receipt: paid, card processing, credit added (= amount)
  gross INTEGER CHECK (gross IS NULL OR gross BETWEEN 1 AND 9007199254740991),
  fee INTEGER CHECK (fee IS NULL OR fee BETWEEN 0 AND 9007199254740991),
  -- how a topup's credit arrived: at checkout, or later for a pending PaymentIntent
  via TEXT CHECK (via IS NULL OR via IN ('checkout', 'charge', 'refetch')),
  -- the other half of a charge: a topup names its Charge, a reversal its PaymentIntent (Stripe's
  -- charge.payment_intent), so whichever arrives second is checked against the first
  ref TEXT CHECK (ref IS NULL OR (length(ref) BETWEEN 4 AND 255 AND ref NOT GLOB '*[^A-Za-z0-9_]*')),
  event_id TEXT REFERENCES stripe_events (event_id),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (kind, stripe_key),
  FOREIGN KEY (iss, sub) REFERENCES identities (iss, sub),
  CHECK (kind <> 'topup' OR (substr(stripe_key, 1, 3) = 'pi_' AND gross IS NOT NULL AND fee IS NOT NULL AND fee < gross AND amount = gross - fee AND via IS NOT NULL AND ref IS NOT NULL AND substr(ref, 1, 3) = 'ch_')),
  CHECK (kind <> 'reversal' OR (ref IS NOT NULL AND substr(ref, 1, 3) = 'pi_')),
  CHECK (kind IN ('topup', 'reversal') OR ref IS NULL),
  CHECK (kind = 'topup' OR (gross IS NULL AND fee IS NULL AND via IS NULL)),
  CHECK (kind <> 'pending' OR (substr(stripe_key, 1, 3) = 'pi_' AND amount = 0)),
  CHECK (kind <> 'refund' OR (substr(stripe_key, 1, 3) = 're_' AND amount < 0)),
  CHECK (kind <> 'reversal' OR (substr(stripe_key, 1, 3) = 'ch_' AND amount < 0)),
  CHECK (kind <> 'restore' OR (substr(stripe_key, 1, 3) = 'ch_' AND amount > 0)),
  CHECK (kind <> 'won' OR (substr(stripe_key, 1, 3) = 'ch_' AND amount = 0)),
  CHECK (kind <> 'signal' OR (substr(stripe_key, 1, 4) = 'evt_' AND amount = 0))
) STRICT;
CREATE INDEX balance_entries_by_person ON balance_entries (iss, sub, seq);
-- one topup per charge, one reversal per PaymentIntent
CREATE UNIQUE INDEX balance_entries_by_ref ON balance_entries (kind, ref) WHERE ref IS NOT NULL;

-- A topup that didn't come from checkout.session.completed needs the PaymentIntent's pending marker
-- (d3.2, B3 amended): no marker, no credit.
CREATE TRIGGER balance_topup_needs_marker BEFORE INSERT ON balance_entries
WHEN NEW.kind = 'topup' AND NEW.via <> 'checkout'
  AND NOT EXISTS (SELECT 1 FROM balance_entries WHERE kind = 'pending' AND stripe_key = NEW.stripe_key AND iss = NEW.iss AND sub = NEW.sub)
BEGIN
  SELECT RAISE(ABORT, 'a later credit needs the PaymentIntent''s pending marker');
END;

-- A topup and the reversal of its charge, in either order: the second must name the first (topup.ref is
-- the reversal's charge, reversal.ref the topup's PaymentIntent), be the same person's, and reverse exactly
-- the net. A row that names only half a pair already taken by another is refused too.
CREATE TRIGGER balance_reversal_matches_topup BEFORE INSERT ON balance_entries
WHEN NEW.kind = 'reversal' AND (
  EXISTS (SELECT 1 FROM balance_entries t WHERE t.kind = 'topup' AND t.stripe_key = NEW.ref
    AND NOT (t.ref = NEW.stripe_key AND t.iss = NEW.iss AND t.sub = NEW.sub AND t.amount = -NEW.amount))
  OR EXISTS (SELECT 1 FROM balance_entries t WHERE t.kind = 'topup' AND t.ref = NEW.stripe_key AND t.stripe_key <> NEW.ref))
BEGIN
  SELECT RAISE(ABORT, 'a reversal must match its charge''s top-up');
END;
CREATE TRIGGER balance_topup_matches_reversal BEFORE INSERT ON balance_entries
WHEN NEW.kind = 'topup' AND (
  EXISTS (SELECT 1 FROM balance_entries r WHERE r.kind = 'reversal' AND r.stripe_key = NEW.ref
    AND NOT (r.ref = NEW.stripe_key AND r.iss = NEW.iss AND r.sub = NEW.sub AND r.amount = -NEW.amount))
  OR EXISTS (SELECT 1 FROM balance_entries r WHERE r.kind = 'reversal' AND r.ref = NEW.stripe_key AND r.stripe_key <> NEW.ref))
BEGIN
  SELECT RAISE(ABORT, 'a top-up must match its charge''s reversal');
END;

-- A restore is exactly its charge's reversal, and needs one.
CREATE TRIGGER balance_restore_matches BEFORE INSERT ON balance_entries
WHEN NEW.kind = 'restore'
  AND NOT EXISTS (SELECT 1 FROM balance_entries WHERE kind = 'reversal' AND stripe_key = NEW.stripe_key AND iss = NEW.iss AND sub = NEW.sub AND amount = -NEW.amount)
BEGIN
  SELECT RAISE(ABORT, 'a restore must equal its charge''s reversal');
END;

-- A person's balance stays an exact JavaScript number: no row may take the running sum outside
-- [-(2^53 - 1), 2^53 - 1]. By induction every SUM is exact (and far inside SQLite's 64-bit range). A replay
-- of a kept key is left to the replay trigger.
CREATE TRIGGER balance_entries_sum_bounded BEFORE INSERT ON balance_entries
WHEN NOT EXISTS (SELECT 1 FROM balance_entries WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key)
  AND abs(COALESCE((SELECT SUM(amount) FROM balance_entries WHERE iss = NEW.iss AND sub = NEW.sub), 0) + NEW.amount) > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'a balance must stay within 2^53 - 1 micro-USD either way');
END;

-- Frozen or not, by the latest row. Automatic rows only freeze (a dispute, a warning, a top-up outside
-- the caps); unfreezing is a human admin's, audited (d2 B1, N2).
CREATE TABLE account_freezes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  -- null for an automatic freeze; the admin's user id for a human change
  by_user TEXT REFERENCES users (id),
  created_ms INTEGER NOT NULL CHECK (created_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (iss, sub) REFERENCES identities (iss, sub),
  CHECK (frozen = 1 OR by_user IS NOT NULL)
) STRICT;
CREATE INDEX account_freezes_by_person ON account_freezes (iss, sub, seq);

-- The individual's GPU plan (d2 H1): Stripe's current state of the Subscription, fetched on every
-- event (d3.2 H2), appended only when it differs from the latest row (state_sha256 is a hash of the
-- compared fields only: Stripe has no updated-at).
CREATE TABLE gpu_plans (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  subscription_id TEXT NOT NULL
    CHECK (length(subscription_id) BETWEEN 5 AND 255 AND substr(subscription_id, 1, 4) = 'sub_' AND substr(subscription_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'canceled', 'paused')),
  current_period_end_ms INTEGER NOT NULL CHECK (current_period_end_ms BETWEEN 0 AND 9007199254740991),
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  fetched_ms INTEGER NOT NULL CHECK (fetched_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (iss, sub) REFERENCES identities (iss, sub)
) STRICT;
CREATE INDEX gpu_plans_by_person ON gpu_plans (iss, sub, seq);
CREATE INDEX gpu_plans_by_subscription ON gpu_plans (subscription_id, seq);

-- Every fetch of a subscription, whether or not its state changed, by the time its request was sent: the
-- fence that keeps an older fetch that commits late (Stripe doesn't order events, and a webhook and the
-- daily re-fetch can overlap) from becoming the latest state. A plan row needs a fetch later than every
-- earlier one.
CREATE TABLE gpu_plan_fetches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL
    CHECK (length(subscription_id) BETWEEN 5 AND 255 AND substr(subscription_id, 1, 4) = 'sub_' AND substr(subscription_id, 5) NOT GLOB '*[^A-Za-z0-9]*'),
  fetched_ms INTEGER NOT NULL CHECK (fetched_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX gpu_plan_fetches_by_subscription ON gpu_plan_fetches (subscription_id, fetched_ms);

CREATE TRIGGER gpu_plans_fenced BEFORE INSERT ON gpu_plans
WHEN EXISTS (SELECT 1 FROM gpu_plan_fetches WHERE subscription_id = NEW.subscription_id AND fetched_ms >= NEW.fetched_ms)
BEGIN SELECT RAISE(ABORT, 'a plan state from an older fetch'); END;

-- A write that meets a kept row's key: the same row again (a replay) is dropped; anything else is refused.
-- REPLACE would delete the kept row without firing BEFORE DELETE, so these run before any conflict
-- clause. Rows compare by what they mean: the person and the money, not when or how they arrived.
CREATE TRIGGER stripe_customers_replay BEFORE INSERT ON stripe_customers
WHEN EXISTS (SELECT 1 FROM stripe_customers WHERE iss = NEW.iss AND sub = NEW.sub AND customer_id = NEW.customer_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER stripe_customers_conflict BEFORE INSERT ON stripe_customers
WHEN EXISTS (SELECT 1 FROM stripe_customers WHERE (iss = NEW.iss AND sub = NEW.sub) <> (customer_id = NEW.customer_id)
  AND ((iss = NEW.iss AND sub = NEW.sub) OR customer_id = NEW.customer_id))
BEGIN SELECT RAISE(ABORT, 'that Customer belongs to another person, or the person has another Customer'); END;
CREATE TRIGGER stripe_events_replay BEFORE INSERT ON stripe_events
WHEN EXISTS (SELECT 1 FROM stripe_events WHERE event_id = NEW.event_id AND type = NEW.type)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER stripe_events_conflict BEFORE INSERT ON stripe_events
WHEN EXISTS (SELECT 1 FROM stripe_events WHERE event_id = NEW.event_id AND type <> NEW.type)
BEGIN SELECT RAISE(ABORT, 'an event id is never reused'); END;
CREATE TRIGGER balance_entries_replay BEFORE INSERT ON balance_entries
WHEN (NEW.seq IS NULL OR NOT EXISTS (SELECT 1 FROM balance_entries WHERE seq = NEW.seq))
  AND EXISTS (SELECT 1 FROM balance_entries WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key
    AND iss = NEW.iss AND sub = NEW.sub AND amount = NEW.amount AND gross IS NEW.gross AND fee IS NEW.fee AND ref IS NEW.ref)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER balance_entries_conflict BEFORE INSERT ON balance_entries
WHEN (NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM balance_entries WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM balance_entries WHERE kind = NEW.kind AND stripe_key = NEW.stripe_key
    AND NOT (iss = NEW.iss AND sub = NEW.sub AND amount = NEW.amount AND gross IS NEW.gross AND fee IS NEW.fee AND ref IS NEW.ref))
  OR (NEW.ref IS NOT NULL AND EXISTS (SELECT 1 FROM balance_entries WHERE kind = NEW.kind AND ref = NEW.ref AND stripe_key <> NEW.stripe_key))
BEGIN SELECT RAISE(ABORT, 'a balance entry is never replaced'); END;
CREATE TRIGGER account_freezes_conflict BEFORE INSERT ON account_freezes
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM account_freezes WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'an account freeze is never replaced'); END;
CREATE TRIGGER gpu_plans_conflict BEFORE INSERT ON gpu_plans
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM gpu_plans WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'a plan row is never replaced'); END;
-- A subscription belongs to the person its first row names: no state change can move it, or let one
-- subscription permit two people's starts.
CREATE TRIGGER gpu_plans_one_owner BEFORE INSERT ON gpu_plans
WHEN EXISTS (SELECT 1 FROM gpu_plans WHERE subscription_id = NEW.subscription_id AND (iss <> NEW.iss OR sub <> NEW.sub))
BEGIN SELECT RAISE(ABORT, 'a subscription belongs to one person'); END;

CREATE TRIGGER stripe_customers_immutable BEFORE UPDATE ON stripe_customers BEGIN SELECT RAISE(ABORT, 'stripe customers are never updated'); END;
CREATE TRIGGER stripe_customers_kept BEFORE DELETE ON stripe_customers BEGIN SELECT RAISE(ABORT, 'stripe customers are never deleted'); END;
CREATE TRIGGER stripe_events_immutable BEFORE UPDATE ON stripe_events BEGIN SELECT RAISE(ABORT, 'stripe events are never updated'); END;
CREATE TRIGGER stripe_events_kept BEFORE DELETE ON stripe_events BEGIN SELECT RAISE(ABORT, 'stripe events are never deleted'); END;
CREATE TRIGGER balance_entries_immutable BEFORE UPDATE ON balance_entries BEGIN SELECT RAISE(ABORT, 'balance entries are never updated'); END;
CREATE TRIGGER balance_entries_kept BEFORE DELETE ON balance_entries BEGIN SELECT RAISE(ABORT, 'balance entries are never deleted'); END;
CREATE TRIGGER account_freezes_immutable BEFORE UPDATE ON account_freezes BEGIN SELECT RAISE(ABORT, 'account freezes are never updated'); END;
CREATE TRIGGER account_freezes_kept BEFORE DELETE ON account_freezes BEGIN SELECT RAISE(ABORT, 'account freezes are never deleted'); END;
CREATE TRIGGER gpu_plans_immutable BEFORE UPDATE ON gpu_plans BEGIN SELECT RAISE(ABORT, 'gpu plans are never updated'); END;
CREATE TRIGGER gpu_plans_kept BEFORE DELETE ON gpu_plans BEGIN SELECT RAISE(ABORT, 'gpu plans are never deleted'); END;
CREATE TRIGGER gpu_plan_fetches_immutable BEFORE UPDATE ON gpu_plan_fetches BEGIN SELECT RAISE(ABORT, 'plan fetches are never updated'); END;
CREATE TRIGGER gpu_plan_fetches_kept BEFORE DELETE ON gpu_plan_fetches BEGIN SELECT RAISE(ABORT, 'plan fetches are never deleted'); END;
CREATE TRIGGER gpu_plan_fetches_conflict BEFORE INSERT ON gpu_plan_fetches
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM gpu_plan_fetches WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'a plan fetch is never replaced'); END;
