-- When the pending top-up re-fetch (stripe-reconcile.ts; Codex audit G01 P2) last asked Stripe about each
-- pending marker's PaymentIntent. Each run takes the open markers checked longest ago, a marker never checked
-- counting as checked when it was created. So the oldest-served go first whatever the run times or how many
-- markers arrive, and no set of markers whose fee isn't known yet can hold every slot (Codex cx3's P2 and
-- TESTS H2 on #128).
--
-- It holds no money, and nothing may read it to decide a credit, a balance or an amount: it only orders
-- which markers the job asks Stripe about next. It is rewritten in place, one row per PaymentIntent
-- (unlike the ledger's append-only tables), and losing it only changes that order.
CREATE TABLE pending_checks (
  stripe_key TEXT PRIMARY KEY
    CHECK (length(stripe_key) BETWEEN 4 AND 255 AND substr(stripe_key, 1, 3) = 'pi_' AND stripe_key NOT GLOB '*[^A-Za-z0-9_]*'),
  checked_ms INTEGER NOT NULL CHECK (checked_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
