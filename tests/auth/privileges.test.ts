import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAuth, withUser } from "../../src/db/index.js";
import { sqlState } from "../db/helpers.js";
import { loginAndLink, mkEnv, type Env } from "./env.js";

let env: Env;
beforeAll(async () => (env = await mkEnv()));
afterAll(() => env.db.end());

describe("privilege separation between the API role and the auth service role", () => {
  it("alfred_app (data API) can not read ANY auth/Zoom table, even for its own user id", async () => {
    const a = await loginAndLink(env);
    for (const t of ["identities", "auth_sessions", "auth_codes", "refresh_tokens", "access_tokens", "oauth_states", "zoom_links", "zoom_events", "stream_associations"])
      expect(await sqlState(withUser(env.db, a.ownerId, (tx) => tx.query(`select * from ${t}`))), t).toBe("42501");
  });
  it("alfred_app can read secret_refs rows of its own user only through RLS (never other users')", async () => {
    const [a, b] = [await loginAndLink(env), await loginAndLink(env)];
    const mine = await withUser(env.db, a.ownerId, (tx) => tx.query("select owner_id from secret_refs"));
    expect(new Set(mine.rows.map((r) => r.owner_id))).toEqual(new Set([a.ownerId]));
    void b;
  });
  it("the auth service can not touch sessions, packets, evidence or assignments", async () => {
    for (const t of ["sessions", "packets", "evidence", "assignments", "gaps", "alerts", "capture_sources"])
      expect(await sqlState(withAuth(env.db, (tx) => tx.query(`select 1 from ${t}`))), t).toBe("42501");
  });
  it("the auth service can not delete users (no erasure power) nor read outbox", async () => {
    expect(await sqlState(withAuth(env.db, (tx) => tx.query("delete from users")))).toBe("42501");
    expect(await sqlState(withAuth(env.db, (tx) => tx.query("select 1 from outbox")))).toBe("42501");
  });
});
