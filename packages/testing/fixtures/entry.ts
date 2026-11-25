// A fixture Worker for @sbgpu/testing's own tests: a var, a Durable Object with SQLite storage.
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  override async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (n INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
    return new Response(String(this.ctx.storage.sql.exec("SELECT count(*) AS n FROM c").one().n));
  }
}

export default {
  async fetch(req: Request, env: { GREETING: string; COUNTER: DurableObjectNamespace; ASSETS?: Fetcher }): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && env.ASSETS) {
      const res = await env.ASSETS.fetch(new URL(path.slice("/assets".length), req.url));
      return new Response(res.body, { status: res.status, headers: { "x-through-worker": "1", "content-type": res.headers.get("content-type") ?? "" } });
    }
    if (path === "/greet") return new Response(env.GREETING);
    if (path === "/count") return env.COUNTER.get(env.COUNTER.idFromName("one")).fetch(req);
    return new Response("not found", { status: 404 });
  },
};
