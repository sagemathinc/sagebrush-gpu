// The UI's one API client: typed by @sbgpu/api's Endpoints, sent with fetch. The mock
// backend plugs in as a fetch function (mock/fetch.ts), so the UI runs the same client
// code against the mock and the real control plane.

import {
  ROUTES,
  buildPath,
  isApiErrorBody,
  type EndpointName,
  type Endpoints,
  type ErrorCode,
} from "@sbgpu/api";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface CallArgs<N extends EndpointName> {
  params?: Endpoints[N]["params"];
  query?: Endpoints[N]["query"];
  body?: Endpoints[N]["body"];
}

/** An API error (its closed code), or "network" / "badResponse" for failures outside the API. */
export class ApiError extends Error {
  readonly code: ErrorCode | "network" | "badResponse";
  readonly status: number;
  constructor(code: ErrorCode | "network" | "badResponse", status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Endpoints whose response is text, not JSON. */
const TEXT_RESPONSES: ReadonlySet<EndpointName> = new Set<EndpointName>(["getSpendCsv"]);

export interface ClientOptions {
  /** Origin and prefix to prepend to paths; "" for same-origin (the default). */
  baseUrl?: string;
  fetch?: FetchFn;
}

export interface Client {
  call<N extends EndpointName>(name: N, args?: CallArgs<N>): Promise<Endpoints[N]["response"]>;
}

export function queryString(query: Record<string, string | undefined> | undefined): string {
  if (query == null) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, value);
  }
  const text = search.toString();
  return text === "" ? "" : "?" + text;
}

export function createClient(options: ClientOptions = {}): Client {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async call<N extends EndpointName>(name: N, args: CallArgs<N> = {}): Promise<Endpoints[N]["response"]> {
      const route = ROUTES[name];
      const path = buildPath(name, (args.params ?? {}) as Record<string, string>);
      const url = baseUrl + path + queryString(args.query as Record<string, string | undefined> | undefined);
      const init: RequestInit = { method: route.method, credentials: "same-origin", headers: { accept: "application/json" } };
      if (route.method !== "GET" && route.method !== "DELETE") {
        init.headers = { accept: "application/json", "content-type": "application/json" };
        init.body = JSON.stringify(args.body ?? {});
      }
      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch (err) {
        throw new ApiError("network", 0, `network error: ${(err as Error).message}`);
      }
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // not JSON; fall through
        }
        if (isApiErrorBody(body)) throw new ApiError(body.error.code, response.status, body.error.message);
        throw new ApiError("badResponse", response.status, `HTTP ${response.status} without an API error body`);
      }
      if (TEXT_RESPONSES.has(name)) return (await response.text()) as Endpoints[N]["response"];
      try {
        return (await response.json()) as Endpoints[N]["response"];
      } catch {
        throw new ApiError("badResponse", response.status, "response is not JSON");
      }
    },
  };
}
