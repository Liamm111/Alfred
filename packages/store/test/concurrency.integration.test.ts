import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConcurrencyError, claimJobs, claimOutbox, createSession, enqueueJob, finishJob, getSession,
  markOutboxPublished, recordPacket, transitionSession, withMaintenance, withUser, inTx,
} from "../src/index.js";
import { activate, ev, freshDb, mkPacket, mkSession, mkUser, sqlState, type Db } from "./helpers.js";

let db: Db, A: string;
beforeAll(async () => {
  db = await freshDb();
  A = await mkUser(db);
});
afterAll(() => db.end());

const outboxCount = async (owner: string, type?: string) =>
  (await withMaintenance(db, (tx) => tx.query("select count(*)::int c from outbox where owner_id=$1 and ($2::text is null or event_type=$2)", [owner, type ?? null]))).rows[0].c as number;

describe("idempotency", () => {
  it("same idempotency key => one session, one outbox event (sequential and 12-way parallel)", async () => {
    const O = await mkUser(db);
    const id = randomUUID();
    const first = await withUser(db, O, (tx) => createSession(tx, { id, owner_id: O, idempotency_key: "same", now_ms: 1 }));
    const second = await withUser(db, O, (tx) => createSession(tx, { id: randomUUID(), owner_id: O, idempotency_key: "same", now_ms: 2 }));
    expect([first.created, second.created]).toEqual([true, false]);
    expect(second.row.id).toBe(id);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => withUser(db, O, (tx) => createSession(tx, { id: randomUUID(), owner_id: O, idempotency_key: "par", now_ms: 1 }))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.row.id)).size).toBe(1);
    expect(await outboxCount(O, "session.created")).toBe(2);
  });

  it("the same idempotency key is scoped per owner", async () => {
    const [P, Q] = [await mkUser(db), await mkUser(db)];
    const a = await mkSession(db, P, "shared-key");
    const b = await mkSession(db, Q, "shared-key");
    expect(a.id).not.toBe(b.id);
  });

  it("duplicate packets (same key, or same epoch/modality/seq) are stored once; 20-way race too", async () => {
    const s = await mkSession(db, A);
    const p = mkPacket(s);
    expect(await withUser(db, A, (tx) => recordPacket(tx, p))).toBe(true);
    expect(await withUser(db, A, (tx) => recordPacket(tx, { ...p, id: randomUUID() }))).toBe(false); // same key
    expect(await withUser(db, A, (tx) => recordPacket(tx, { ...p, id: randomUUID(), idempotency_key: "other" }))).toBe(false); // same seq

    const q = mkPacket(s, { seq: 777 });
    const race = await Promise.all(Array.from({ length: 20 }, () => withUser(db, A, (tx) => recordPacket(tx, { ...q, id: randomUUID(), idempotency_key: randomUUID() }))));
    expect(race.filter(Boolean)).toHaveLength(1);
    expect((await withUser(db, A, (tx) => tx.query("select 1 from packets where session_id=$1 and seq=777", [s.id]))).rowCount).toBe(1);
  });

  it("jobs: idempotent enqueue", async () => {
    const r = await Promise.all(Array.from({ length: 8 }, () => withUser(db, A, (tx) => enqueueJob(tx, { owner_id: A, type: "summarize", payload: { s: 1 }, idempotency_key: "job-1" }))));
    expect(r.filter((x) => x.created)).toHaveLength(1);
    expect(new Set(r.map((x) => x.id)).size).toBe(1);
  });
});

describe("races", () => {
  it("optimistic concurrency: of two writers on the same version exactly one wins, and the loser leaves no outbox event", async () => {
    const O = await mkUser(db);
    const s = await mkSession(db, O);
    const before = await outboxCount(O, "session.state_changed");
    const attempts = await Promise.allSettled(
      [1, 2, 3, 4].map((i) => withUser(db, O, (tx) => transitionSession(tx, s.id, s.version, { source_epoch: i }, 10 + i, ev(`w${i}`)))),
    );
    const wins = attempts.filter((a) => a.status === "fulfilled");
    const losses = attempts.filter((a) => a.status === "rejected");
    expect(wins).toHaveLength(1);
    for (const l of losses) expect((l as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);
    expect(await outboxCount(O, "session.state_changed")).toBe(before + 1);
    expect((await withUser(db, O, (tx) => getSession(tx, s.id)))!.version).toBe(s.version + 1);
  });

  it("stale version is refused", async () => {
    const O = await mkUser(db);
    const s = await mkSession(db, O);
    await withUser(db, O, (tx) => transitionSession(tx, s.id, s.version, { source_epoch: 1 }, 5, ev("a")));
    await expect(withUser(db, O, (tx) => transitionSession(tx, s.id, s.version, { source_epoch: 2 }, 6, ev("b")))).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("two sessions of one owner can not both become active, even when started simultaneously", async () => {
    const O = await mkUser(db);
    const [s1, s2] = [await mkSession(db, O), await mkSession(db, O)];
    const r = await Promise.allSettled([activate(db, s1), activate(db, s2)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("23505");
  });

  it("different owners activate concurrently without interference", async () => {
    const owners = await Promise.all([mkUser(db), mkUser(db), mkUser(db)]);
    const sessions = await Promise.all(owners.map((o) => mkSession(db, o)));
    const r = await Promise.allSettled(sessions.map((s) => activate(db, s)));
    expect(r.every((x) => x.status === "fulfilled")).toBe(true);
  });

  it("job claiming: 6 concurrent workers never take the same job (SKIP LOCKED)", async () => {
    const O = await mkUser(db);
    await withUser(db, O, async (tx) => {
      for (let i = 0; i < 30; i++) await enqueueJob(tx, { owner_id: O, type: "claim-test", payload: { i }, idempotency_key: `c${i}` });
    });
    const taken = await Promise.all(
      Array.from({ length: 6 }, (_, w) =>
        withMaintenance(db, async (tx) => {
          const mine: string[] = [];
          for (;;) {
            const got = await claimJobs(tx, `w${w}`, 3);
            if (!got.length) break;
            mine.push(...got.filter((g) => g.type === "claim-test").map((g) => g.id));
          }
          return mine;
        }),
      ),
    );
    const all = taken.flat();
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
  });

  it("job retry and dead-lettering", async () => {
    const O = await mkUser(db);
    const { id } = await withUser(db, O, (tx) => enqueueJob(tx, { owner_id: O, type: "flaky", payload: {}, idempotency_key: "f" }));
    await withMaintenance(db, (tx) => tx.query("update jobs set max_attempts=2 where id=$1", [id]));
    for (let i = 0; i < 2; i++) {
      const got = await withMaintenance(db, (tx) => claimJobs(tx, "w", 50));
      expect(got.some((g) => g.id === id)).toBe(true);
      await withMaintenance(db, async (tx) => finishJob(tx, id, { ok: false, error: "boom", retryInSeconds: 0 }));
    }
    const row = (await withMaintenance(db, (tx) => tx.query("select status, attempts from jobs where id=$1", [id]))).rows[0];
    expect(row).toEqual({ status: "dead", attempts: 2 });
  });
});

describe("transaction + outbox", () => {
  it("state change and event commit together or not at all", async () => {
    const O = await mkUser(db);
    const s = await mkSession(db, O);
    const before = await outboxCount(O);
    await expect(
      withUser(db, O, async (tx) => {
        await transitionSession(tx, s.id, s.version, { source_epoch: 4 }, 9, ev("rolled-back"));
        throw new Error("crash after write, before commit");
      }),
    ).rejects.toThrow(/crash/);
    expect(await outboxCount(O)).toBe(before);
    expect((await withUser(db, O, (tx) => getSession(tx, s.id)))!.source_epoch).toBe(0);

    // a constraint violation in the same tx also drops the event
    const code = await sqlState(withUser(db, O, async (tx) => {
      await transitionSession(tx, s.id, s.version, { source_epoch: 1 }, 9, ev("x"));
      await tx.query("update sessions set state='LIVE_AV' where id=$1", [s.id]);
    }));
    expect(code).toBe("23514");
    expect(await outboxCount(O)).toBe(before);
  });

  it("dedupe key makes event emission idempotent", async () => {
    const O = await mkUser(db);
    const s = await mkSession(db, O);
    const e = { event_type: "session.state_changed", payload: {}, dedupe_key: "fixed" };
    const r1 = await withUser(db, O, (tx) => transitionSession(tx, s.id, s.version, { source_epoch: 1 }, 1, e));
    await withUser(db, O, (tx) => transitionSession(tx, s.id, r1.version, { source_epoch: 2 }, 2, e));
    expect(await outboxCount(O, "session.state_changed")).toBe(1);
  });

  it("relay: concurrent relays publish each event exactly once", async () => {
    const O = await mkUser(db);
    // start from an empty queue so the 4 relays only compete for this test's events
    await withMaintenance(db, (tx) => tx.query("update outbox set published_at = now() where published_at is null"));
    for (let i = 0; i < 10; i++) await mkSession(db, O);
    const published: number[][] = await Promise.all(
      Array.from({ length: 4 }, () =>
        inTx(db, async (tx) => {
          await tx.query("set local role alfred_maintenance");
          const rows = (await claimOutbox(tx, 4)).filter((r) => r.owner_id === O);
          await markOutboxPublished(tx, rows.map((r) => r.id));
          return rows.map((r) => r.id);
        }),
      ),
    );
    const flat = published.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.length).toBeGreaterThan(0);
    // drain the rest and check the total
    const rest = await withMaintenance(db, async (tx) => { const r = (await claimOutbox(tx, 100)).filter((x) => x.owner_id === O); await markOutboxPublished(tx, r.map((x) => x.id)); return r.length; });
    expect(flat.length + rest).toBe(10);
  });
});
