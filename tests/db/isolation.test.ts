import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssignment, createEvidence, enqueueJob, eraseUser, getSession, openGap, raiseAlert, recordPacket, runRetention, withMaintenance, withUser } from "../../src/db/index.js";
import { SCHEMA_VERSION } from "../../src/contracts/index.js";
import { activate, freshDb, mkPacket, mkSession, mkUser, sqlState, type Db } from "./helpers.js";

let db: Db, A: string, B: string;
beforeAll(async () => {
  db = await freshDb();
  A = await mkUser(db);
  B = await mkUser(db);
});
afterAll(() => db.end());

describe("DB role hardening", () => {
  it("alfred_app is neither superuser, BYPASSRLS, nor a table owner", async () => {
    const r = await db.query("select rolsuper, rolbypassrls from pg_roles where rolname='alfred_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await db.query("select count(*)::int c from pg_tables where schemaname='public' and tableowner='alfred_app'");
    expect(owned.rows[0].c).toBe(0);
  });
  it("every table carrying owner_id has RLS enabled; every table alfred_app can touch has an owner policy", async () => {
    const r = await db.query(`
      select c.relname, c.relrowsecurity,
        has_table_privilege('alfred_app', c.oid, 'select') app_sel,
        (select count(*)::int from pg_policies p where p.tablename = c.relname and p.roles @> array['alfred_app']::name[]) pol
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attname='owner_id' and not a.attisdropped
      where n.nspname='public' and c.relkind='r'`);
    expect(r.rowCount).toBeGreaterThanOrEqual(20);
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      if (row.app_sel) expect(row.pol, row.relname).toBeGreaterThanOrEqual(1);
    }
  });
  it("no raw media column exists: the only bytea columns are encrypted envelopes (secrets, PKCE verifier)", async () => {
    const r = await db.query(`select table_name, column_name from information_schema.columns
      where table_schema='public' and data_type='bytea' order by 1,2`);
    expect(r.rows).toEqual([
      { table_name: "oauth_states", column_name: "verifier_ct" },
      { table_name: "oauth_states", column_name: "verifier_nonce" },
      { table_name: "secret_refs", column_name: "ciphertext" },
      { table_name: "secret_refs", column_name: "nonce" },
    ]);
  });
});

describe("cross-user access is impossible", () => {
  it("B sees nothing of A, can not update/delete it, can not insert on behalf of A", async () => {
    const sa = await mkSession(db, A);
    await withUser(db, A, (tx) => recordPacket(tx, mkPacket(sa)));

    await withUser(db, B, async (tx) => {
      expect(await getSession(tx, sa.id)).toBeNull();
      expect((await tx.query("select * from sessions")).rowCount).toBe(0);
      expect((await tx.query("select * from packets")).rowCount).toBe(0);
      expect((await tx.query("update sessions set failure_reason='x' where id=$1", [sa.id])).rowCount).toBe(0);
      expect((await tx.query("delete from sessions where id=$1", [sa.id])).rowCount).toBe(0);
      expect((await tx.query("delete from users where id=$1", [A])).rowCount).toBe(0);
    });
    // untouched for A
    await withUser(db, A, async (tx) => {
      expect((await getSession(tx, sa.id))?.failure_reason).toBeNull();
      expect((await tx.query("select 1 from packets")).rowCount).toBe(1);
    });
    // B inserts a session owned by A -> RLS WITH CHECK
    const code = await sqlState(withUser(db, B, (tx) => tx.query("insert into sessions (id, owner_id, state, idempotency_key, created_at_ms, updated_at_ms) values ($1,$2,'IDLE','x',1,1)", [randomUUID(), A])));
    expect(code).toBe("42501");
  });

  it("composite FKs refuse cross-owner links even for a role that bypasses RLS", async () => {
    const sa = await mkSession(db, A);
    // maintenance sees everything: it still can not attach B's packet to A's session
    const bad = mkPacket(sa, { owner_id: B });
    const code = await sqlState(withMaintenance(db, (tx) => recordPacket(tx, bad)));
    expect(code).toBe("23503");
  });

  it("no app.user_id => no rows (fail closed)", async () => {
    await mkSession(db, A);
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("set local role alfred_app");
      expect((await c.query("select * from sessions")).rowCount).toBe(0);
      expect((await c.query("select * from users")).rowCount).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("app.user_id does not leak to the next request on a pooled connection", async () => {
    const one = await createOnePool();
    await withUser(one, A, async (tx) => void (await tx.query("select 1")));
    const r = await one.query("select current_setting('app.user_id', true) v, current_user u");
    expect([null, ""]).toContain(r.rows[0].v);
    expect(r.rows[0].u).not.toBe("alfred_app");
    await one.end();
  });

  it("a user can not read another user's row in users, retention policy, jobs, outbox or secrets", async () => {
    await withMaintenance(db, async (tx) => {
      await tx.query("insert into retention_policies (owner_id, packets_days) values ($1, 30)", [A]);
      await tx.query("insert into secret_refs (owner_id, purpose, key_id, ciphertext, nonce) values ($1,'t','k1',decode(repeat('ab',32),'hex'),decode(repeat('cd',12),'hex'))", [A]);
    });
    await withUser(db, A, (tx) => enqueueJob(tx, { owner_id: A, type: "t", payload: {}, idempotency_key: "j" }));
    await withUser(db, B, async (tx) => {
      for (const t of ["users", "retention_policies", "jobs", "outbox", "secret_refs"]) expect((await tx.query(`select 1 from ${t}`)).rowCount, t).toBe(t === "users" ? 1 : 0);
    });
  });
});

describe("integrity constraints", () => {
  it("LIVE_* is impossible without persisted proof of media", async () => {
    const s = await mkSession(db, A);
    const noProof = sqlState(withUser(db, A, (tx) => tx.query("update sessions set state='LIVE_AUDIO' where id=$1", [s.id])));
    expect(await noProof).toBe("23514");
    const wrongModality = sqlState(withUser(db, A, (tx) => tx.query("update sessions set state='LIVE_AV', verified_packets=1, last_audio_wall_ms=5 where id=$1", [s.id])));
    expect(await wrongModality).toBe("23514");
    const transcriptOnly = sqlState(withUser(db, A, (tx) => tx.query("update sessions set state='LIVE_AUDIO', verified_packets=1, last_transcript_wall_ms=5 where id=$1", [s.id])));
    expect(await transcriptOnly).toBe("23514");
    expect(await sqlState(withUser(db, A, (tx) => tx.query("update sessions set state='LIVE_AUDIO', verified_packets=1, last_audio_wall_ms=5 where id=$1", [s.id])))).toBeUndefined();
  });

  it("terminal states are final, outcome matches, source_epoch never decreases, identity immutable", async () => {
    const s = await mkSession(db, B);
    const q = (sql: string, p: unknown[] = []) => sqlState(withUser(db, B, (tx) => tx.query(sql, [s.id, ...p])));
    expect(await q("update sessions set state='COMPLETED' where id=$1")).toBe("23514"); // no outcome
    expect(await q("update sessions set state='FAILED', outcome='completed' where id=$1")).toBe("23514");
    expect(await q("update sessions set state='FAILED', outcome='failed' where id=$1")).toBeUndefined();
    expect(await q("update sessions set state='IDLE', outcome=null where id=$1")).toBe("23514"); // terminal is final
    expect(await q("update sessions set owner_id=$2 where id=$1", [A])).toBeTruthy(); // RLS check or immutability trigger
    const s2 = await mkSession(db, B);
    await withUser(db, B, (tx) => tx.query("update sessions set source_epoch=3 where id=$1", [s2.id]));
    expect(await sqlState(withUser(db, B, (tx) => tx.query("update sessions set source_epoch=2 where id=$1", [s2.id])))).toBe("23514");
  });

  it("evidence needs packets and assignments need evidence (checked at commit)", async () => {
    const s = await mkSession(db, A);
    const p = mkPacket(s);
    await withUser(db, A, (tx) => recordPacket(tx, p));
    const evId = randomUUID();
    const evidence = { schema_version: SCHEMA_VERSION, id: evId, session_id: s.id, owner_id: A, kind: "transcript_span", modality: "transcript", packet_ids: [p.id], start_ms: 1, end_ms: 2, text: "synthetic", confidence: 0.9, created_at_ms: 3 };
    await withUser(db, A, (tx) => createEvidence(tx, evidence));
    const asg = { schema_version: SCHEMA_VERSION, id: randomUUID(), session_id: s.id, owner_id: A, title: "synthetic task", assignee_label: null, due_at_ms: null, status: "open", evidence_ids: [evId], created_at_ms: 4 };
    await withUser(db, A, (tx) => createAssignment(tx, asg));

    // bypass the repo (which validates with Zod) to hit the DB guard directly
    const orphanEvidence = sqlState(withUser(db, A, (tx) => tx.query("insert into evidence (id, session_id, owner_id, kind, modality, start_ms, end_ms, text, confidence, created_at_ms) values ($1,$2,$3,'transcript_span','transcript',1,2,'x',0.5,1)", [randomUUID(), s.id, A])));
    expect(await orphanEvidence).toBe("23514");
    const orphanAssignment = sqlState(withUser(db, A, (tx) => tx.query("insert into assignments (id, session_id, owner_id, title, status, created_at_ms) values ($1,$2,$3,'t','open',1)", [randomUUID(), s.id, A])));
    expect(await orphanAssignment).toBe("23514");
    // evidence citing someone else's packet is impossible
    const sb = await mkSession(db, B);
    const pb = mkPacket(sb);
    await withUser(db, B, (tx) => recordPacket(tx, pb));
    const steal = sqlState(withUser(db, A, async (tx) => { await createEvidence(tx, { ...evidence, id: randomUUID(), packet_ids: [pb.id] }); }));
    expect(await steal).toBeTruthy();
  });

  it("contracts are validated before insert (raw media field refused)", async () => {
    const s = await mkSession(db, A);
    await expect(withUser(db, A, (tx) => recordPacket(tx, { ...mkPacket(s), raw_audio: "AAAA" }))).rejects.toThrow();
  });

  it("only one open gap per modality and one open alert per code", async () => {
    const s = await mkSession(db, A);
    const gap = { schema_version: SCHEMA_VERSION, id: randomUUID(), session_id: s.id, owner_id: A, modality: "audio", source_epoch: 1, start_ms: 1, end_ms: null, reason: "silence" };
    await withUser(db, A, (tx) => openGap(tx, gap));
    expect(await sqlState(withUser(db, A, (tx) => openGap(tx, { ...gap, id: randomUUID() })))).toBe("23505");
    const alert = { schema_version: SCHEMA_VERSION, id: randomUUID(), session_id: s.id, owner_id: A, severity: "warning", code: "media_silence", message: "m", raised_at_ms: 1, resolved_at_ms: null };
    await withUser(db, A, (tx) => raiseAlert(tx, alert));
    expect(await sqlState(withUser(db, A, (tx) => raiseAlert(tx, { ...alert, id: randomUUID() })))).toBe("23505");
  });

  it("secrets must be encrypted envelopes or external refs, never bare", async () => {
    const ins = (cols: string, vals: string) => sqlState(withMaintenance(db, (tx) => tx.query(`insert into secret_refs (owner_id, purpose, key_id, ${cols}) values ($1, 'p'||gen_random_uuid()::text, 'k', ${vals})`, [A])));
    expect(await ins("ciphertext", "decode(repeat('ab',32),'hex')")).toBe("23514"); // no nonce
    expect(await ins("ciphertext, nonce", "decode('abcd','hex'), decode('00','hex')")).toBe("23514"); // too short to be GCM
    expect(await ins("purpose", "'x'")).toBeTruthy(); // duplicate column / invalid
    expect(await ins("external_ref", "'kms://synthetic/key-1'")).toBeUndefined();
  });
});

describe("retention", () => {
  it("purges expired packets per user policy, keeps evidence longer, never touches fresh data", async () => {
    const U = await mkUser(db), V = await mkUser(db);
    await withMaintenance(db, (tx) => tx.query("insert into retention_policies (owner_id, packets_days, evidence_days) values ($1, 2, 400)", [V]));
    const mk = async (u: string) => {
      const s = await mkSession(db, u);
      const old = mkPacket(s), fresh = mkPacket(s);
      await withUser(db, u, async (tx) => { await recordPacket(tx, old); await recordPacket(tx, fresh); });
      await withMaintenance(db, (tx) => tx.query("update packets set created_at = now() - interval '5 days' where id=$1", [old.id]));
      const evId = randomUUID();
      await withUser(db, u, (tx) => createEvidence(tx, { schema_version: SCHEMA_VERSION, id: evId, session_id: s.id, owner_id: u, kind: "audio_summary", modality: "audio", packet_ids: [old.id, fresh.id], start_ms: 1, end_ms: 2, text: "s", confidence: 1, created_at_ms: 1 }));
      return { s, old, fresh, evId };
    };
    const u = await mk(U), v = await mk(V);
    const r = await withMaintenance(db, (tx) => runRetention(tx));
    expect(Number(r.deleted_packets)).toBe(1); // only V's 5-day-old packet (policy 2d); U keeps the 7d default
    const left = async (id: string) => (await withMaintenance(db, (tx) => tx.query("select id from packets where session_id=$1", [id]))).rows.map((x) => x.id).sort();
    expect(await left(u.s.id)).toEqual([u.old.id, u.fresh.id].sort());
    expect(await left(v.s.id)).toEqual([v.fresh.id]);
    // evidence survives its packets; its link to the purged packet is gone
    const links = await withMaintenance(db, (tx) => tx.query("select packet_id from evidence_packets where evidence_id=$1", [v.evId]));
    expect(links.rows.map((x) => x.packet_id)).toEqual([v.fresh.id]);
    expect((await withMaintenance(db, (tx) => tx.query("select 1 from evidence where id=$1", [v.evId]))).rowCount).toBe(1);
    // later: evidence ages out too
    await withMaintenance(db, (tx) => tx.query("update evidence set created_at = now() - interval '100 days' where id=$1", [u.evId]));
    const r2 = await withMaintenance(db, (tx) => runRetention(tx));
    expect(Number(r2.deleted_evidence)).toBe(1);
    expect((await withMaintenance(db, (tx) => tx.query("select 1 from evidence where id=$1", [u.evId]))).rowCount).toBe(0);
  });

  it("alfred_app can not run retention for others", async () => {
    expect(await sqlState(withUser(db, A, (tx) => runRetention(tx)))).toBe("42501");
  });
});

describe("verifiable erasure and cascades", () => {
  it("erase_user removes every trace, leaves others intact, and writes an anonymous receipt", async () => {
    const X = await mkUser(db), Y = await mkUser(db);
    const sx = await mkSession(db, X), sy = await mkSession(db, Y);
    const px = mkPacket(sx), py = mkPacket(sy);
    await withUser(db, X, async (tx) => { await recordPacket(tx, px); await enqueueJob(tx, { owner_id: X, type: "t", payload: {}, idempotency_key: "k" }); });
    await withUser(db, Y, (tx) => recordPacket(tx, py));
    await withMaintenance(db, (tx) => tx.query("insert into secret_refs (owner_id, purpose, key_id, external_ref) values ($1,'p','k','kms://x')", [X]));

    const res = await withUser(db, X, (tx) => eraseUser(tx, X));
    expect(res.verified).toBe(true);
    expect(res.deleted.packets).toBe(1);
    expect(res.deleted.secret_refs).toBe(1);

    const remaining = await withMaintenance(db, (tx) => tx.query(`select
      (select count(*)::int from users where id=$1) u, (select count(*)::int from sessions where owner_id=$1) s,
      (select count(*)::int from packets where owner_id=$1) p, (select count(*)::int from jobs where owner_id=$1) j,
      (select count(*)::int from outbox where owner_id=$1) o, (select count(*)::int from secret_refs where owner_id=$1) r`, [X]));
    expect(remaining.rows[0]).toEqual({ u: 0, s: 0, p: 0, j: 0, o: 0, r: 0 });
    expect((await withMaintenance(db, (tx) => tx.query("select 1 from packets where owner_id=$1", [Y]))).rowCount).toBe(1);

    const receipts = await withMaintenance(db, (tx) => tx.query("select * from deletion_receipts where verified"));
    const last = receipts.rows.at(-1);
    expect(JSON.stringify(last)).not.toContain(X); // anonymous: hash only
    expect(last.user_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a user can not erase someone else; nothing is deleted", async () => {
    const X = await mkUser(db);
    await mkSession(db, X);
    expect(await sqlState(withUser(db, A, (tx) => eraseUser(tx, X)))).toBe("42501");
    expect((await withMaintenance(db, (tx) => tx.query("select 1 from sessions where owner_id=$1", [X]))).rowCount).toBe(1);
  });

  it("deleting a session cascades to its children; FKs block orphan inserts", async () => {
    const X = await mkUser(db);
    const s = await mkSession(db, X);
    const p = mkPacket(s);
    await withUser(db, X, (tx) => recordPacket(tx, p));
    await withUser(db, X, (tx) => tx.query("delete from sessions where id=$1", [s.id]));
    expect((await withMaintenance(db, (tx) => tx.query("select 1 from packets where id=$1", [p.id]))).rowCount).toBe(0);
    expect(await sqlState(withUser(db, X, (tx) => recordPacket(tx, p)))).toBe("23503"); // session is gone
  });
});

describe("synthetic seed", () => {
  it("refuses to run without explicit opt-in, and loads only synthetic data with it", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../db/seed/synthetic_seed.sql", import.meta.url), "utf8");
    const c = await db.connect();
    try {
      await expect(c.query(sql)).rejects.toThrow(/seed refused/);
      await c.query("begin");
      await c.query("set local alfred.allow_seed = 'on'");
      await c.query(sql);
      const r = await c.query("select count(*)::int n from sessions where meeting_uuid like 'synthetic-%'");
      expect(r.rows[0].n).toBe(2);
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect(sql).not.toMatch(/@[a-z]+\.[a-z]+/i);
  });
});

async function createOnePool() {
  const { createPool } = await import("../../src/db/index.js");
  return createPool(undefined, 1); // a single connection: the next request reuses the previous one
}
