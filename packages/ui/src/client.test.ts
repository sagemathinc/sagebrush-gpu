import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient, queryString, type FetchFn } from "./client.ts";

function recorder(response: () => Response): { fetch: FetchFn; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

test("queryString skips undefined and encodes", () => {
  assert.equal(queryString(undefined), "");
  assert.equal(queryString({}), "");
  assert.equal(queryString({ a: undefined }), "");
  assert.equal(queryString({ all: "1", cursor: "a b&c" }), "?all=1&cursor=a+b%26c");
});

test("GET: path params, query, no body, same-origin credentials", async () => {
  const r = recorder(() => Response.json({ items: [], next: null }));
  const c = createClient({ baseUrl: "https://api.example", fetch: r.fetch });
  await c.call("listMachines", { params: { projectId: "prj_1" }, query: { all: "1" } });
  assert.equal(r.calls[0]?.url, "https://api.example/v1/projects/prj_1/machines?all=1");
  assert.equal(r.calls[0]?.init.method, "GET");
  assert.equal(r.calls[0]?.init.body, undefined);
  assert.equal(r.calls[0]?.init.credentials, "same-origin");
});

test("POST and PUT send JSON; DELETE sends no body", async () => {
  const r = recorder(() => Response.json({ ok: true }));
  const c = createClient({ fetch: r.fetch });
  await c.call("stopMachine", { params: { machineId: "mch_1" }, body: { save: false } });
  assert.equal(r.calls[0]?.url, "/v1/machines/mch_1/stop");
  assert.equal(r.calls[0]?.init.body, '{"save":false}');
  assert.equal((r.calls[0]?.init.headers as Record<string, string>)["content-type"], "application/json");
  await c.call("setMemberAllocation", { params: { projectId: "prj_1", memberId: "mbr_1" }, body: { amount: 5 } });
  assert.equal(r.calls[1]?.init.method, "PUT");
  await c.call("saveMachine", { params: { machineId: "mch_1" } });
  assert.equal(r.calls[2]?.init.body, "{}");
  await c.call("deleteMachine", { params: { machineId: "mch_1" } });
  assert.equal(r.calls[3]?.init.method, "DELETE");
  assert.equal(r.calls[3]?.init.body, undefined);
});

test("missing or unsafe path params never reach fetch", async () => {
  const r = recorder(() => Response.json({}));
  const c = createClient({ fetch: r.fetch });
  await assert.rejects(c.call("getMachine", {}), RangeError);
  await assert.rejects(c.call("getMachine", { params: { machineId: "../me" } }), RangeError);
  assert.equal(r.calls.length, 0);
});

test("API errors keep their code and status", async () => {
  const c = createClient({ fetch: recorder(() => Response.json({ error: { code: "priceCap", message: "too dear" } }, { status: 422 })).fetch });
  await assert.rejects(c.call("getMe"), (e: unknown) => e instanceof ApiError && e.code === "priceCap" && e.status === 422 && e.message === "too dear");
});

test("non-API failures are badResponse or network", async () => {
  const html = createClient({ fetch: recorder(() => new Response("<html>", { status: 502 })).fetch });
  await assert.rejects(html.call("getMe"), (e: unknown) => e instanceof ApiError && e.code === "badResponse" && e.status === 502);
  const unknownCode = createClient({ fetch: recorder(() => Response.json({ error: { code: "teapot", message: "" } }, { status: 418 })).fetch });
  await assert.rejects(unknownCode.call("getMe"), (e: unknown) => e instanceof ApiError && e.code === "badResponse");
  const notJson = createClient({ fetch: recorder(() => new Response("ok", { status: 200 })).fetch });
  await assert.rejects(notJson.call("getMe"), (e: unknown) => e instanceof ApiError && e.code === "badResponse");
  const down = createClient({
    fetch: async () => {
      throw new TypeError("connection refused");
    },
  });
  await assert.rejects(down.call("getMe"), (e: unknown) => e instanceof ApiError && e.code === "network" && e.status === 0);
});

test("the spend CSV comes back as text", async () => {
  const c = createClient({ fetch: recorder(() => new Response("a,b\r\n", { headers: { "content-type": "text/csv" } })).fetch });
  assert.equal(await c.call("getSpendCsv", { params: { projectId: "prj_1" }, query: { by: "day" } }), "a,b\r\n");
});
