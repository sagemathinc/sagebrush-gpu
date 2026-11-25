// The relay's test Worker (relay.test.ts, in Miniflare): the production routes and object, with a logical clock the
// tests can move (the object's own `now`, offset by what /__clock last set), and a revoke route for the tests (control
// calls revokeMachine through its binding; there is no external revoke route in production).
import { MachineRelay, type RelayEnv } from "./relay.ts";
import { relayRoute, revokeMachine, type RelayRouteEnv } from "./routes.ts";

export class TestMachineRelay extends MachineRelay {
  private offset = 0;
  private frozen: number | null = null;
  private failJti = false;
  private rate: { perSecond: number; burst: number } | null = null;
  protected override machineRate(): { perSecond: number; burst: number } {
    return this.rate ?? super.machineRate();
  }
  protected override consumeJti(jti: string, exp: number): "consumed" | "used" | "full" {
    if (this.failJti) throw new Error("storage failure (test)");
    return super.consumeJti(jti, exp);
  }
  protected override now(): number {
    return this.frozen ?? Date.now() + this.offset;
  }
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__clock") {
      this.offset = Number(await req.text());
      await this.alarm(); // (deadlines checked at the new time)
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__freeze") {
      const t = await req.text();
      this.frozen = t === "" ? null : Number(t);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__bucket") {
      // (the stored bucket set to t bytes now, nothing reserved)
      const t = Number(await req.text());
      this.machine = { t, at: this.now() };
      this.reserved = 0;
      this.ctx.storage.sql.exec("INSERT INTO kv (k, v) VALUES ('machineBucket', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(this.machine));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__take") {
      return Response.json({ ok: this.machineTake(Number(await req.text())), reserved: this.reserved });
    }
    if (url.pathname === "/__machinerate") {
      this.rate = JSON.parse(await req.text()) as { perSecond: number; burst: number };
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__failjti") {
      this.failJti = (await req.text()) === "1";
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__state") {
      const rows = this.ctx.storage.sql.exec("SELECT k, v FROM kv").toArray();
      const used = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM used_jti").one().n;
      return Response.json({ kv: Object.fromEntries(rows.map((r) => [r.k, r.v])), usedJtis: used, legs: this.ctx.getWebSockets().length });
    }
    return super.fetch(req);
  }
}

export default {
  async fetch(req: Request, env: RelayEnv & RelayRouteEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__test/revoke") {
      const { mch, inc } = (await req.json()) as { mch: string; inc: number };
      return Response.json({ acknowledged: await revokeMachine(env, mch, inc) });
    }
    if (url.pathname.startsWith("/__test/do/")) {
      const mch = url.pathname.split("/")[3]!;
      const stub = env.MACHINE_RELAY.get(env.MACHINE_RELAY.idFromName(mch) as never);
      const inner = "https://relay.internal/" + url.pathname.split("/").slice(4).join("/");
      return stub.fetch(inner, { method: req.method, body: req.method === "POST" ? await req.text() : null, headers: { "x-r-mch": mch } });
    }
    return (await relayRoute(req, env)) ?? new Response("not found", { status: 404 });
  },
};
