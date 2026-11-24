// The mock backend as a fetch function, so the UI's client (client.ts) talks to it exactly
// as it talks to the control plane.

import type { FetchFn } from "../client.ts";
import type { MockBackend } from "./backend.ts";

export function mockFetch(backend: MockBackend): FetchFn {
  return async (input, init) => {
    const url = new URL(input, "https://mock.invalid");
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init.body === "string" && init.body !== "") {
      try {
        body = JSON.parse(init.body);
      } catch {
        return Response.json({ error: { code: "badRequest", message: "body is not JSON" } }, { status: 400 });
      }
    }
    const res = backend.request(method, url.pathname, Object.fromEntries(url.searchParams), body);
    if (res.contentType === "text/csv") {
      return new Response(String(res.body), { status: res.status, headers: { "content-type": "text/csv; charset=utf-8" } });
    }
    return Response.json(res.body, { status: res.status });
  };
}
