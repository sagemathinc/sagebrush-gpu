-- When the orphan sweep (sweep.ts) last tried to end each orphan machine, and how many times (Codex audit
-- G03; William's fleet rule: no retry without back-off). A new orphan is tried at once; after n attempts
-- the next waits min(SWEEP_BACKOFF_BASE_MS * 2^(n-1), SWEEP_BACKOFF_CAP_MS) from the last one, so a
-- provider that keeps refusing a termination isn't asked every minute. The attempt is recorded before
-- the call, whatever its outcome (a lost reply may still have ended the machine).
--
-- It holds no money, and nothing may read it to decide a launch, a charge or a balance: it only says when
-- the sweep may ask again. It is rewritten in place, one row per (provider, machine), and a row whose
-- machine is no longer an orphan is deleted by the run that sees that; losing it only makes the next
-- attempt immediate.
CREATE TABLE sweep_attempts (
  -- (the sweep is RunPod's container sweep; another provider's is admitted with its own migration)
  provider TEXT NOT NULL CHECK (provider IN ('runpod')),
  provider_machine_id TEXT NOT NULL
    -- (control's rule for a provider's machine id, container.ts PROVIDER_ID: 1 to 64 printable ASCII)
    CHECK (length(provider_machine_id) BETWEEN 1 AND 64 AND provider_machine_id NOT GLOB '*[^!-~]*'),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  last_ms INTEGER NOT NULL CHECK (last_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (provider, provider_machine_id)
) STRICT;
