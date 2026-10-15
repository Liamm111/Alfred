/**
 * Immutable feature flags. `bot_join` is the literal `false`: it is a type-level and runtime constant, not configuration
 * (see env.ts: BOT_JOIN can only be unset or "false"). Nothing in the repo may start another Zoom identity (PRD v0.2 invariant).
 */
export const FEATURES = Object.freeze({ bot_join: false as const });
export type Features = typeof FEATURES;
