# Control's migrations: the PROD checklist

Control has never been deployed to PROD. D1 migrations reach PROD only with William's OK for each file, in
his session, after they have run on DEV (control's first DEV deploy applies them all, in order). Before
control's first PROD deploy, every file below needs that OK. A new migration adds its line here in the same
PR (a test checks that every file in this directory is listed).

| File | What it does |
|---|---|
| 0001_ledger.sql | The ledger and what it charges against. |
| 0002_auth.sql | People and sign-in. |
| 0003_members.sql | Invariants of members and allocations, enforced by the database. |
| 0004_availability.sql | The availability record: provider listings and real launch attempts. |
| 0005_teams.sql | Teams: groups of a project's members with a shared allocation. |
| 0006_projects.sql | Organizations' credit, and projects' policy and display labels. |
| 0007_sessions.sql | Sign-in moves to WorkOS AuthKit. |
| 0008_identities.sql | Sign-in through WorkOS AuthKit: who signed in is a WorkOS identity. |
| 0009_vm_launches.sql | VM mode: a launch's public facts. |
| 0010_vm_launch_intent.sql | VM mode: a launch is recorded before its create request. |
| 0011_billing_mode.sql | How an organization pays for machines: resold or BYOK. |
| 0012_vm_enroll.sql | VM enroll: a launch pins the agent's hash at its intent. |
| 0013_agent_heartbeat.sql | The agent's heartbeat. |
| 0014_launches.sql | One launch record for both launch modes. |
| 0015_launch_rates.sql | A launch's pinned rate. |
| 0016_provider_credentials.sql | An organization's own provider keys, sealed. |
| 0017_area_restores.sql | Workspace snapshots: restore's exclusion. |
| 0018_heartbeat_all_modes.sql | The heartbeat watchdog covers every enrolled launch. |
| 0019_start_admission.sql | Starting a machine: admission. |
| 0020_container_lifetime.sql | The hard lifetime of a container launch. |
| 0021_credential_assurance.sql | Recent reauthentication with MFA proven per session. |
| 0022_stripe_ledger.sql | GPU billing: an individual's prepaid balance through Stripe, and their plan (money). |
| 0023_allocation_commitments.sql | An allocation never gives back money it has already committed (money). |
| 0024, 0025 | Reserved for open PRs (the admin limit and its assurances). |
| 0026_allocations_kept.sql | An allocation is never deleted (money). |
| 0027_org_payments.sql | Organization payments through Stripe, credited net (money; with #125). |
| 0028_pending_checks.sql | When the pending top-up re-fetch last asked Stripe about each marker. Holds no money; nothing credits from it. |
