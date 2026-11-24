# Rules for agents working in this repo

- No credentials anywhere: not in code, tests, fixtures, commits or notes. Provider API
  keys live only in the control plane's secrets.
- No spending: no real provider launches, paid API calls or deploys. Tests use mocks or
  recorded responses.
- Public text (code, comments, commits, PR bodies) never names customers or institutions.
- Keep changes small and focused, one topic per branch. Every change comes with tests that
  would fail on its obvious mutants (a flipped comparison, an off-by-one, a dropped term).
- Run `bash scripts/check.sh` before handing a branch over for review.
