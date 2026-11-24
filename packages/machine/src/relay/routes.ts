// The relay's routes in the control Worker (DESIGN.md section 4), and control's revoke.  The Worker only routes: every
// leg is authenticated inside the machine's object, by its first message (SEC ruling, Nov 24), so a token is never in
// a URL, and the Worker passes on no header but the upgrade and the machine id.
//
//   wss://<api>/api/relay/v1/peer?machine=<mch>                  the machine's agent
//   wss://<api>/api/relay/v1/page?machine=<mch>&chan=terminal     a member's page
import { isId } from "@sbgpu/api";
import { CHANNELS } from "./caps.ts";

/** The Durable Object binding, as much of it as the routes use (so this file builds for Node's tests too). */
export interface RelayNamespace {
  idFromName(name: string): unknown;
  get(id: never): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

export interface RelayRouteEnv {
  MACHINE_RELAY: RelayNamespace;
}

const PREFIX = "/api/relay/v1/";
const json = (status: number, error: string) => Response.json({ error }, { status });

/** The relay's response to `req`, or null if it isn't a relay path (the Worker's other routes then answer). */
export async function relayRoute(req: Request, env: RelayRouteEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const side = url.pathname.slice(PREFIX.length);
  if (side !== "peer" && side !== "page") return json(404, "not found");
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, "upgrade required");
  // (exactly the expected parameters, once each: nothing else, so no token or anything else ever rides in the URL)
  const keys = [...url.searchParams.keys()];
  const want = side === "peer" ? ["machine"] : ["machine", "chan"];
  if (keys.length !== want.length || !want.every((k) => url.searchParams.getAll(k).length === 1)) return json(400, "bad request");
  const mch = url.searchParams.get("machine")!;
  if (!isId("machine", mch)) return json(400, "bad request");
  const chan = url.searchParams.get("chan");
  if (side === "page" && !(CHANNELS as readonly string[]).includes(chan!)) return json(400, "unknown channel");
  const inner = new URL("https://relay.internal/leg");
  inner.searchParams.set("side", side);
  if (side === "page") inner.searchParams.set("chan", chan!);
  const stub = env.MACHINE_RELAY.get(env.MACHINE_RELAY.idFromName(mch) as never);
  return stub.fetch(inner.toString(), { headers: { upgrade: "websocket", "x-r-mch": mch } });
}

/**
 * Control's revoke of a machine's incarnations up to `inc` (a stop or a restart): true only when the machine's object
 * acknowledged it after its durable write (revokedThrough >= inc).  Anything else (an error, a timeout, an unexpected
 * answer) is false: control keeps the stop pending, retries, and mints no page token meanwhile (SEC ruling).
 */
export async function revokeMachine(env: RelayRouteEnv, mch: string, inc: number): Promise<boolean> {
  if (!isId("machine", mch) || !Number.isSafeInteger(inc) || inc < 0) return false;
  try {
    const stub = env.MACHINE_RELAY.get(env.MACHINE_RELAY.idFromName(mch) as never);
    const r = await stub.fetch("https://relay.internal/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-r-mch": mch },
      body: JSON.stringify({ inc }),
    });
    if (r.status !== 200) return false;
    const body = (await r.json()) as { ok?: unknown; revokedThrough?: unknown };
    return body.ok === true && typeof body.revokedThrough === "number" && body.revokedThrough >= inc;
  } catch {
    return false;
  }
}
