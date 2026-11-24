# RunPod test fixtures

- `catalog-gpus.json`: GPU entries (ids, names, prices, flags) from a real `GET /v2/catalog/gpus`
  response recorded Nov 16 2026, trimmed to six GPU types. The `availability` and `dataCenters`
  fields are added by hand in the shape of RunPod's OpenAPI spec (`include=AVAILABILITY`); the
  stock levels are made up for the tests.
- `pod-running.json`: the Pod example from RunPod's OpenAPI spec (v2), changed to the shape our
  launch requests (name, entrypoint, no ports, no volume, only the boot token in env, L4 in
  EU-SE-1). The token value is a placeholder.
- `error-no-capacity.json`: a real create-pod refusal body, recorded Nov 16 2026, verbatim.

No fixture holds a credential or an account identifier.
