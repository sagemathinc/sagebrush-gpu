import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, buildPath, matchRoute, type EndpointName } from "./routes.ts";
import { newId } from "./ids.ts";

const NAMES = Object.keys(ROUTES) as EndpointName[];

function sampleParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const seg of path.split("/")) {
    if (!seg.startsWith(":")) continue;
    const name = seg.slice(1);
    if (name === "provider") {
      params[name] = "shadeform";
      continue;
    }
    const kind = ({ orgId: "org", projectId: "project", memberId: "member", teamId: "team", machineId: "machine" } as const)[name];
    assert.ok(kind, `unknown path parameter ${name}`);
    params[name] = newId(kind);
  }
  return params;
}

test("every route is under /v1 with well-formed segments", () => {
  for (const name of NAMES) {
    const { path } = ROUTES[name];
    assert.match(path, /^\/v1(\/(:[a-zA-Z]+|[a-z0-9.-]+))+$/, name);
  }
});

test("no two routes can match the same request", () => {
  for (let i = 0; i < NAMES.length; i++) {
    for (let j = i + 1; j < NAMES.length; j++) {
      const a = ROUTES[NAMES[i]!];
      const b = ROUTES[NAMES[j]!];
      if (a.method !== b.method) continue;
      const as = a.path.split("/");
      const bs = b.path.split("/");
      if (as.length !== bs.length) continue;
      const distinct = as.some((s, k) => !s.startsWith(":") && !bs[k]!.startsWith(":") && s !== bs[k]);
      assert.ok(distinct, `${NAMES[i]} and ${NAMES[j]} overlap`);
    }
  }
});

test("matchRoute finds each route from its own built path", () => {
  for (const name of NAMES) {
    const params = sampleParams(ROUTES[name].path);
    const path = buildPath(name, params);
    assert.deepEqual(matchRoute(ROUTES[name].method, path), { name, params }, name);
  }
});

test("matchRoute rejects near misses", () => {
  const m = newId("machine");
  assert.equal(matchRoute("POST", `/v1/machines/${m}/stop`)?.name, "stopMachine");
  assert.equal(matchRoute("GET", `/v1/machines/${m}/stop`), null);
  assert.equal(matchRoute("POST", `/v1/machines/${m}/stop/`), null);
  assert.equal(matchRoute("POST", `/v1/machines/${m}/stop/x`), null);
  assert.equal(matchRoute("POST", `/v1/machines//stop`), null);
  assert.equal(matchRoute("POST", `/v1/machines/a%2Fb/stop`), null);
  assert.equal(matchRoute("POST", `/v1/machines/a b/stop`), null);
  assert.equal(matchRoute("POST", `/v2/machines/${m}/stop`), null);
  assert.equal(matchRoute("POST", `v1/machines/${m}/stop`), null);
  assert.equal(matchRoute("post", `/v1/machines/${m}/stop`), null);
  assert.deepEqual(matchRoute("GET", "/v1/me"), { name: "getMe", params: {} });
  const p = newId("project");
  assert.equal(matchRoute("GET", `/v1/projects/${p}/spend.csv`)?.name, "getSpendCsv");
  assert.equal(matchRoute("GET", `/v1/projects/${p}/spend`)?.name, "getSpend");
  assert.equal(matchRoute("GET", `/v1/projects/${p}/spendxcsv`), null);
});

test("buildPath refuses missing or unsafe parameters", () => {
  assert.throws(() => buildPath("getMachine", {}), RangeError);
  assert.throws(() => buildPath("getMachine", { machineId: "../x" }), RangeError);
  assert.throws(() => buildPath("getMachine", { machineId: "" }), RangeError);
  assert.equal(buildPath("getMe", {}), "/v1/me");
});

test("access rules", () => {
  const publicRoutes = NAMES.filter((n) => ROUTES[n].access.auth === "public").sort();
  assert.deepEqual(publicRoutes, ["agentAbort", "agentAnnounce", "agentEnroll", "signInCallback", "startSignIn"]);
  const system = NAMES.filter((n) => ROUTES[n].access.auth === "system");
  assert.deepEqual(system, ["addOrgCredit"]);
  for (const n of NAMES) {
    const r = ROUTES[n];
    const isAgentPath = r.path.startsWith("/v1/agent/");
    assert.equal(isAgentPath, r.access.auth === "agent" || n === "agentEnroll" || n === "agentAbort" || n === "agentAnnounce", n);
    // machine routes are checked against the machine's project; project routes against the project
    if (r.access.auth === "session" && r.access.scope === "machine") assert.ok(r.path.startsWith("/v1/machines/:machineId"), n);
    if (r.access.auth === "session" && r.access.scope === "project") assert.ok(r.path.startsWith("/v1/projects/:projectId"), n);
    if (r.access.auth === "session" && r.access.scope === "org") assert.ok(r.path.startsWith("/v1/orgs/:orgId"), n);
  }
  const min = (n: EndpointName) => {
    const a = ROUTES[n].access;
    return "minRole" in a ? a.minRole : null;
  };
  // money and membership changes need a manager or more
  for (const n of ["setMemberAllocation", "setTeamAllocation", "inviteMembers", "removeMember", "updateProject", "listLedger"] as const) {
    assert.equal(min(n), "manager", n);
  }
  assert.equal(min("moveProjectBudget"), "owner");
  assert.equal(min("createProject"), "owner");
  assert.equal(min("getSpendCsv"), "assistant");
  assert.equal(min("startMachine"), "member");
});
