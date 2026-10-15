/**
 * Multi-session registry with atomic stop-all (BLOC 01).
 *
 * Rules:
 *  - at most ONE active session per owner (a second start is refused, never merged);
 *  - events are routed by session_id only; a packet carrying another session's id is
 *    rejected by the machine (`wrong_session`) and can never leak liveness across sessions;
 *  - `stopAll` is all-or-nothing: every transition is computed first on copies, and the
 *    registry is mutated only if all succeeded.
 */
import { DEFAULT_THRESHOLDS, type Thresholds } from "./freshness.js";
import {
  checkInvariants,
  isActive,
  newContext,
  step,
  type Clock,
  type Effect,
  type MachineEvent,
  type SessionContext,
  type StepResult,
} from "./state-machine.js";

export class RegistryError extends Error {
  constructor(
    readonly code: "ALREADY_ACTIVE" | "UNKNOWN_SESSION" | "DUPLICATE_SESSION" | "FORBIDDEN" | "INVARIANT",
    message: string,
  ) {
    super(message);
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionContext>();
  constructor(private readonly thresholds: Thresholds = DEFAULT_THRESHOLDS) {}

  get(id: string): SessionContext | undefined {
    return this.sessions.get(id);
  }
  list(): SessionContext[] {
    return [...this.sessions.values()];
  }
  activeFor(owner_id: string): SessionContext | undefined {
    return this.list().find((s) => s.owner_id === owner_id && isActive(s.state));
  }

  create(a: { session_id: string; owner_id: string }, now: Clock): SessionContext {
    if (this.sessions.has(a.session_id)) throw new RegistryError("DUPLICATE_SESSION", "session id exists");
    const ctx = newContext(a, now);
    this.sessions.set(a.session_id, ctx);
    return ctx;
  }

  /** Dispatch; `actor_owner_id` must own the session (cross-owner access is refused). */
  dispatch(actor_owner_id: string, session_id: string, event: MachineEvent, now: Clock): StepResult {
    const cur = this.sessions.get(session_id);
    if (!cur) throw new RegistryError("UNKNOWN_SESSION", session_id);
    if (cur.owner_id !== actor_owner_id) throw new RegistryError("FORBIDDEN", "not the owner");
    if (event.type === "DETECT") {
      const other = this.activeFor(cur.owner_id);
      if (other && other.session_id !== session_id)
        throw new RegistryError("ALREADY_ACTIVE", `owner already has active session ${other.session_id}`);
    }
    const r = step(cur, event, now, this.thresholds);
    if (r.ok) this.sessions.set(session_id, r.ctx);
    return r;
  }

  /** Heartbeat for every session (each independent). */
  tickAll(now: Clock): Map<string, Effect[]> {
    const out = new Map<string, Effect[]>();
    for (const [id, cur] of this.sessions) {
      const r = step(cur, { type: "TICK" }, now, this.thresholds);
      if (r.ok) {
        this.sessions.set(id, r.ctx);
        out.set(id, r.effects);
      }
    }
    return out;
  }

  /**
   * Atomic stop-all. Optionally restricted to one owner. Throws (and changes nothing)
   * if any targeted session is corrupt or its stop is refused.
   */
  stopAll(now: Clock, owner_id?: string): { stopped: string[]; effects: Map<string, Effect[]> } {
    const next = new Map<string, SessionContext>();
    const effects = new Map<string, Effect[]>();
    for (const [id, cur] of this.sessions) {
      if (owner_id && cur.owner_id !== owner_id) continue;
      if (!isActive(cur.state) || cur.state === "FINALIZING") continue; // already stopping: nothing to do
      const bad = checkInvariants(cur);
      if (bad.length) throw new RegistryError("INVARIANT", `${id}: ${bad.join("; ")}`);
      const r = step(cur, { type: "STOP" }, now, this.thresholds);
      if (!r.ok) throw new RegistryError("INVARIANT", `${id}: ${r.message}`);
      next.set(id, r.ctx);
      effects.set(id, r.effects);
    }
    for (const [id, ctx] of next) this.sessions.set(id, ctx); // commit point: no throw possible past here
    return { stopped: [...next.keys()], effects };
  }
}
