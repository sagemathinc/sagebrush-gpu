# Mutation check for packages/providers: apply each mutant, run the tests, list survivors.
# Usage: python3 -I scripts/mutants-providers.py .   (from the repo root)
import subprocess, sys, pathlib
root = pathlib.Path(sys.argv[1]) / "packages/providers/src"
M = [
 # money
 ("money.ts", "usd < 0) {", "usd < -1) {"),
 ("money.ts", "Math.round(usd * 1_000_000)", "Math.floor(usd * 1_000_000)"),
 ("money.ts", "if (!Number.isSafeInteger(micros)) throw", "if (false) throw"),
 # machine names
 ("machine-name.ts", "if (!name.startsWith(PREFIX)) return null;", ""),
 ("machine-name.ts", "if (!isId(\"machine\", machineId)) throw", "if (false) throw"),
 ("machine-name.ts", "return isId(\"machine\", id) ? id : null;", "return id;"),
 # locality
 ("locality.ts", "...EU_COUNTRIES, ...EEA_NON_EU, \"GB\"", "...EU_COUNTRIES, ...EEA_NON_EU"),
 ("locality.ts", "...EU_COUNTRIES, ...EEA_NON_EU, \"GB\"", "...EU_COUNTRIES, \"GB\""),
 ("locality.ts", "return country !== null && locality.includes(country);", "return country === null || locality.includes(country);"),
 ("locality.ts", "if (allowedCountries === null) return base;", ""),
 ("locality.ts", "base.filter((c) => allowedCountries.includes(c))", "[...allowedCountries]"),
 ("locality.ts", "return base === \"any\" ? [...allowedCountries] :", "return base === \"any\" ? \"any\" :"),
 # errors
 ("errors.ts", "case \"price_above_cap\":\n      return \"next\";", "case \"price_above_cap\":\n      return \"stop\";"),
 ("errors.ts", "    case \"forbidden\":\n", ""),
 ("errors.ts", "    case \"outcome_unknown\":\n", "    case \"outcome_unknown\":\n      return \"next\";\n"),
 ("errors.ts", "    case \"transient\":\n      return \"retry\";", "    case \"transient\":\n      return \"next\";"),
 # placement
 ("placement.ts", "if (!policy.allowedGpuTypes.includes(request.gpuType)) return [];", ""),
 ("placement.ts", "o.gpuCount === request.gpuCount &&", ""),
 ("placement.ts", "policy.allowedProviders.includes(o.provider) &&", ""),
 ("placement.ts", "countryAllowed(policy.locality, o.country) &&", ""),
 ("placement.ts", "o.providerCostPerHour <= policy.maxProviderCostPerHour &&", "o.providerCostPerHour < policy.maxProviderCostPerHour &&"),
 ("placement.ts", "o.stock !== \"none\",", "true,"),
 ("placement.ts", "a.providerCostPerHour - b.providerCostPerHour ||", "b.providerCostPerHour - a.providerCostPerHour ||"),
 ("placement.ts", "STOCK_ORDER[a.stock] - STOCK_ORDER[b.stock] ||", ""),
 ("placement.ts", "compare(a.provider, b.provider) ||", ""),
 ("placement.ts", "  high: 0,\n  medium: 1,", "  high: 1,\n  medium: 0,"),
 ("placement.ts", "step < 2 && priceSplit(p + 1, marginBps).total <= maxTotal; step++) p++;", "step < 2; step++) p++;"),
 ("placement.ts", "for (let step = 0; step < 2 &&", "for (let step = 0; step < 0 &&"),
 ("placement.ts", "let p = Math.floor((maxTotal * 10_000) / (10_000 + marginBps));", "let p = 0;"),
 ("placement.ts", "if (!Number.isSafeInteger(maxTotal) || maxTotal < 0) throw", "if (false) throw"),
 ("placement.ts", "maxProviderCostPerHour: providerCapForTotal(policy.maxPricePerHour, marginBps),", "maxProviderCostPerHour: policy.maxPricePerHour,"),
 ("placement.ts", "if (calls >= maxAttempts) {", "if (calls > maxAttempts) {"),
 ("placement.ts", "if (action === \"retry\" && retry < maxRetries) {", "if (action === \"retry\" && retry <= maxRetries) {"),
 ("placement.ts", "if (action === \"stop\") throw", "if (false) throw"),
 ("placement.ts", "retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 1000 * 2 ** retry", "1000 * 2 ** retry"),
 ("placement.ts", "return Math.min(ms, MAX_BACKOFF_MS);", "return ms;"),
 ("placement.ts", "if (!(e instanceof ProviderError)) throw e;", "if (!(e instanceof ProviderError)) continue;"),
 # drift
 ("drift.ts", "if (observed.state === \"terminated\") return [];", "if (observed.state !== \"running\") return [];"),
 ("drift.ts", "check(\"volumeGb\", 0, observed.volumeGb);", ""),
 ("drift.ts", "check(\"exposedPorts\", [], observed.exposedPorts);", ""),
 ("drift.ts", "check(\"command\", expected.command, observed.command);", ""),
 ("drift.ts", "check(\"image\", expected.image, observed.image);", ""),
 ("drift.ts", "check(\"diskGb\", expected.diskGb, observed.diskGb);", ""),
 ("drift.ts", "check(\"dataCenter\", expected.dataCenter, observed.dataCenter);", ""),
 ("drift.ts", "check(\"gpuType\", expected.gpuType, observed.gpuType);", ""),
 ("drift.ts", "check(\"gpuCount\", expected.gpuCount, observed.gpuCount);", ""),
 ("drift.ts", "check(\"machineId\", expected.machineId, observed.machineId);", ""),
 ("drift.ts", "check(\"providerMachineId\", expected.providerMachineId, observed.providerMachineId);", ""),
 ("drift.ts", "[...expected.envNames].sort(), [...observed.envNames].sort()", "[...expected.envNames], [...observed.envNames]"),
 ("drift.ts", "check(\"envNames\",", "if (false) check(\"envNames\","),
 ("drift.ts", "if (rate === null || rate > expected.maxProviderCostPerHour) {", "if (rate !== null && rate > expected.maxProviderCostPerHour) {"),
 ("drift.ts", "if (rate === null || rate > expected.maxProviderCostPerHour) {", "if (rate === null || rate >= expected.maxProviderCostPerHour) {"),
 # http
 ("http.ts", "!/^[0-9]{1,6}$/.test(value.trim())", "!/^-?[0-9.]{1,6}$/.test(value.trim())"),
 # runpod catalog
 ("runpod/catalog.ts", "if (prefix === \"US\") return \"US\";", ""),
 ("runpod/catalog.ts", "if (prefix === \"CA\" && second === \"MTL\") return \"CA\";", "if (prefix === \"CA\") return \"CA\";"),
 ("runpod/catalog.ts", "(prefix === \"EU\" || prefix === \"EUR\")", "(prefix === \"EU\")"),
 ("runpod/catalog.ts", "if (parts.length !== 3 || !/^[0-9]+$/.test(parts[2]!)) return null;", "if (parts.length < 2) return null;"),
 ("runpod/catalog.ts", "return Object.hasOwn(RUNPOD_GPUS, runpodId) ? RUNPOD_GPUS[runpodId]! : null;", "return RUNPOD_GPUS[runpodId] ?? null;"),
 # runpod adapter
 ("runpod/adapter.ts", "NO_CAPACITY.test(detail) ? \"no_capacity\" : \"unplaceable\"", "\"unplaceable\""),
 ("runpod/adapter.ts", "status === 429 ? retryAfterSeconds(retryAfter) : null,", "retryAfterSeconds(retryAfter),"),
 ("runpod/adapter.ts", "status >= 500 && status <= 599", "status >= 500"),
 ("runpod/adapter.ts", "return detail.slice(0, 300);", "return detail;"),
 ("runpod/adapter.ts", "  EXITED: \"failed\",\n", "  EXITED: \"running\",\n"),
 ("runpod/adapter.ts", "  STARTING: \"provisioning\",\n", ""),
 ("runpod/adapter.ts", "(network + globalVolumes > 0 ? Number.POSITIVE_INFINITY : 0)", "0"),
 ("runpod/adapter.ts", "env = isObject(pod[\"env\"]) ? Object.keys(pod[\"env\"]) : []", "env = isObject(pod[\"env\"]) ? Object.values(pod[\"env\"]).map(String) : []"),
 ("runpod/adapter.ts", "typeof cost === \"number\" && Number.isFinite(cost) && cost >= 0 ? usdToMicros(cost) : null", "typeof cost === \"number\" ? usdToMicros(Math.abs(cost)) : null"),
 ("runpod/adapter.ts", "args !== \"\" ? [`args:${args}`] : [...entrypoint, ...cmd]", "args !== \"\" ? [] : [...entrypoint, ...cmd]"),
 ("runpod/adapter.ts", "g[\"secure\"] !== true) continue;", "false) continue;"),
 ("runpod/adapter.ts", "!(price > 0)) continue;", "price < 0) continue;"),
 ("runpod/adapter.ts", "providerCostPerHour: perGpu * query.gpuCount,", "providerCostPerHour: perGpu,"),
 ("runpod/adapter.ts", "if (country === null) continue;", ""),
 ("runpod/adapter.ts", "cloud: \"SECURE\", count: String(query.gpuCount)", "cloud: \"SECURE\", count: \"1\""),
 ("runpod/adapter.ts", "      ports: [],\n      startSsh: false,", "      startSsh: false,"),
 ("runpod/adapter.ts", "startSsh: false,", "startSsh: true,"),
 ("runpod/adapter.ts", "cloud: \"SECURE\",\n      gpu:", "cloud: \"COMMUNITY\",\n      gpu:"),
 ("runpod/adapter.ts", "      mounts: {},\n", ""),
 ("runpod/adapter.ts", "if (spec.bootToken === \"\") throw", "if (false) throw"),
 ("runpod/adapter.ts", "(e.kind !== \"outcome_unknown\" && e.kind !== \"transient\")", "(e.kind !== \"outcome_unknown\")"),
 ("runpod/adapter.ts", "if (found.length === 0) throw e;", "if (found.length === 0) throw new ProviderError(\"runpod\", \"outcome_unknown\", e.message);"),
 ("runpod/adapter.ts", "if (found.length > 1) {", "if (found.length > 2) {"),
 ("runpod/adapter.ts", "s.machineId === machineId && s.state !== \"terminated\"", "s.machineId === machineId"),
 ("runpod/adapter.ts", "(d) => !(d.field === \"dataCenter\" && status.dataCenter === null),", "(d) => d.field !== \"dataCenter\","),
 ("runpod/adapter.ts", "      await this.terminate(status.providerMachineId);\n", ""),
 ("runpod/adapter.ts", "priceOnly ? \"price_above_cap\" : \"invalid_request\"", "\"price_above_cap\""),
 ("runpod/adapter.ts", "&& status.providerCostPerHour !== null;", ";"),
 ("runpod/adapter.ts", "if (e instanceof ProviderError && e.kind === \"not_found\") return goneStatus", "if (e instanceof ProviderError) return goneStatus"),
 ("runpod/adapter.ts", "if (e instanceof ProviderError && e.kind === \"not_found\") return;", "if (e instanceof ProviderError) return;"),
 ("runpod/adapter.ts", "if (s.machineId !== null) out.push(s);", "out.push(s);"),
 ("runpod/adapter.ts", "if (pagination[\"hasNextPage\"] !== true) return out;", "if (pagination[\"nextCursor\"] === null) return out;"),
 ("runpod/adapter.ts", "if (cursor !== null) qs.set(\"cursor\", cursor);", ""),
 ("runpod/adapter.ts", "`/v2/pods/${encodeURIComponent(providerMachineId)}`);\n      return podStatus", "`/v2/pods/${providerMachineId}`);\n      return podStatus"),
 ("runpod/adapter.ts", "const name = e instanceof Error ? e.name : \"error\";", "const name = e instanceof Error ? e.message : \"error\";"),
]
tests = [str(p) for p in root.rglob("*.test.ts")]
survivors = 0
for f, old, new in M:
    p = root / f; src = p.read_text()
    if src.count(old) != 1:
        print("BAD MUTANT (not unique):", f, old[:60]); survivors += 1; continue
    p.write_text(src.replace(old, new))
    try:
        r = subprocess.run(["node", "--test", "--test-reporter=dot", *tests], capture_output=True, text=True, timeout=120)
    finally:
        p.write_text(src)
    if r.returncode == 0:
        survivors += 1; print("SURVIVED:", f, "|", old[:70], "->", new[:70])
print(f"{len(M)} mutants, {survivors} survived")
