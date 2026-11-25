# @sbgpu/api

The API contract: types for every object and endpoint, shared by every package and
client (the UI, the providers, the control plane, Sagebrush). Lane: control.

| File | What |
|---|---|
| `money.ts` | `Micros` (integer micro-USD), `PriceSplit {providerCost, margin, total}`, the one rounding rule (half-up), margins in basis points, `costForSeconds`, `entrySplit` (one ledger entry: provider cost rounded, then the margin on it rounded) |
| `budget.ts` | The ledger rule (one entry per machine per UTC minute, `entrySplit`), and the hard stop and start check computed from that same per-entry charge (`chargeBound`); fail closed on invalid input |
| `authz.ts` | The membership policy: who may invite, change and remove whom; the last-owner guard |
| `objects.ts` | Organization, Project + ProjectPolicy, Member, Team, Allocation, SpendMeter, LedgerEntry, Quote, Machine (states, transitions, stop reasons, save status), agent request/response shapes |
| `routes.ts` | `Endpoints` (types of every endpoint) and `ROUTES` (method, path, access), `matchRoute`, `buildPath` |
| `tokens.ts` | The opaque boot token (`bootExchange`), the claims of each signed token kind, the closed validator `validateClaims`, and `machineTokenStateOk` |
| `credentials.ts` | An organization's own provider keys (byok): `ProviderCredential` and its statuses, `isCredentialKeyShape`, the reauth window (`RECENT_AUTH_WINDOW_MS`, `isRecentAuthForMs`) and the fixed `CREDENTIAL_REFUSALS` |
| `providers.ts` | `ProviderId`, `Offer`, `ProviderMachineStatus` (the adapter interface itself is in @sbgpu/providers) |
| `ids.ts`, `time.ts`, `errors.ts` | Prefixed ids, ISO-8601 UTC times, the error shape and its closed set of codes |

Mutation check: `python3 -I scripts/mutants.py packages/api` (the list is `mutants.json`).
