// Agent authentication (heartbeat design r2, SEC clear): routes with `auth: "agent"` take the
// machine's agent token from `Authorization: Bearer <token>` only, verified against the
// deployment's pinned public keys, for a machine still at the token's incarnation in a state
// where its agent may act. A VM's launch must also still be enrolled: any other launch state
// kills its agent's authorization at once, whatever the token's expiry. (No container path
// exists yet, so a machine without an enrolled VM launch is refused too.) Every refusal is the
// same 401, with no state change.

import { machineTokenStateOk, verifyToken, type AgentClaims, type MachineState } from "@sbgpu/api";
import type { Ctx } from "./app.ts";
import { HttpError } from "./http.ts";

const BEARER = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;

const REFUSED = () => new HttpError("unauthenticated", "refused");

export async function agentAuth(ctx: Ctx): Promise<AgentClaims> {
  const { deps } = ctx;
  const m = BEARER.exec(ctx.req.headers.get("authorization") ?? "");
  if (!m) throw REFUSED();
  const keys = await deps.agentPublicKeys();
  if (!keys) {
    deps.alert("agent auth: the pinned public keys aren't ready");
    throw REFUSED();
  }
  const v = await verifyToken(m[1], keys, "agent", Math.floor(deps.now() / 1000));
  if (!v.ok) throw REFUSED();
  const c = v.claims;
  const rows = await deps.db.all<{ state: MachineState; incarnation: number; outcome: string | null }>(
    `SELECT m.state, m.incarnation, v.outcome FROM machines m
     LEFT JOIN vm_launches v ON v.machine_id = m.id AND v.incarnation = m.incarnation
     WHERE m.id = ?`,
    [c.mch],
  );
  const r = rows[0];
  if (!r || !machineTokenStateOk(c, { id: c.mch, state: r.state, incarnation: r.incarnation }) || r.outcome !== "enrolled") throw REFUSED();
  return c;
}
