// Signed-in sessions for tests, without WorkOS.

import { newId } from "@sbgpu/api";
import type { AppDeps } from "../app.ts";
import { base64url, sessionCookie, sha256Hex } from "../http.ts";

/**
 * A local session for tests, as a sign-in leaves a person: their user (created on the
 * first, by email), their invitations made active, and a session with no WorkOS refresh
 * token (so it is never revalidated). Nothing in the app makes such a session: real ones
 * come from the WorkOS callback (auth.ts). Returns the Set-Cookie value and the user.
 */
export async function startSession(deps: AppDeps, email: string): Promise<{ setCookie: string; userId: string }> {
  const now = deps.now();
  const sessionValue = base64url(deps.randomBytes(32));
  await deps.db.batch([
    { sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING`, params: [newId("user"), email, now] },
    {
      sql: `UPDATE members SET user_id = (SELECT id FROM users WHERE email = ?), status = 'active'
            WHERE email = ? AND status = 'invited' AND user_id IS NULL`,
      params: [email, email],
    },
    {
      sql: `INSERT INTO sessions (id_sha256, user_id, created_ms, expires_ms) SELECT ?, id, ?, ? FROM users WHERE email = ?`,
      params: [await sha256Hex(sessionValue), now, now + deps.config.sessionTtlMs, email],
    },
  ]);
  const user = await deps.db.all<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
  return { setCookie: sessionCookie(sessionValue, Math.floor(deps.config.sessionTtlMs / 1000)), userId: user[0]!.id };
}
