import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routePath } from "./router.ts";

test("parseRoute", () => {
  assert.deepEqual(parseRoute("/"), { name: "home" });
  assert.deepEqual(parseRoute(""), { name: "home" });
  assert.deepEqual(parseRoute("/p/prj_abc"), { name: "project", projectId: "prj_abc" });
  assert.deepEqual(parseRoute("/p/prj_abc/"), { name: "project", projectId: "prj_abc" });
  assert.deepEqual(parseRoute("/p/"), { name: "notFound" });
  assert.deepEqual(parseRoute("/p/a/b"), { name: "notFound" });
  assert.deepEqual(parseRoute("/p/prj_abc/manage"), { name: "manage", projectId: "prj_abc" });
  assert.deepEqual(parseRoute("/p/prj_abc/manage/"), { name: "manage", projectId: "prj_abc" });
  assert.deepEqual(parseRoute("/p/prj_abc/manage/x"), { name: "notFound" });
  assert.deepEqual(parseRoute("/p/a%2Fb/manage"), { name: "notFound" });
  assert.deepEqual(parseRoute("/p/a%2Fb"), { name: "notFound" });
  assert.deepEqual(parseRoute("/q/prj_abc"), { name: "notFound" });
  assert.deepEqual(parseRoute("/x"), { name: "notFound" });
  assert.deepEqual(parseRoute("/o/org_abc"), { name: "org", orgId: "org_abc" });
  assert.deepEqual(parseRoute("/o/org_abc/"), { name: "org", orgId: "org_abc" });
  assert.deepEqual(parseRoute("/o/"), { name: "notFound" });
  assert.deepEqual(parseRoute("/o/org_abc/projects"), { name: "notFound" });
  assert.deepEqual(parseRoute("/o/a%2Fb"), { name: "notFound" });
});

test("routePath round-trips", () => {
  assert.equal(routePath({ name: "home" }), "/");
  assert.equal(routePath({ name: "notFound" }), "/");
  assert.equal(routePath({ name: "project", projectId: "prj_abc" }), "/p/prj_abc");
  assert.deepEqual(parseRoute(routePath({ name: "project", projectId: "prj_abc" })), { name: "project", projectId: "prj_abc" });
  assert.equal(routePath({ name: "manage", projectId: "prj_abc" }), "/p/prj_abc/manage");
  assert.deepEqual(parseRoute(routePath({ name: "manage", projectId: "prj_abc" })), { name: "manage", projectId: "prj_abc" });
  assert.equal(routePath({ name: "org", orgId: "org_abc" }), "/o/org_abc");
  assert.deepEqual(parseRoute(routePath({ name: "org", orgId: "org_abc" })), { name: "org", orgId: "org_abc" });
});
