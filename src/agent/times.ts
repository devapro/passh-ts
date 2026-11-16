// Time in the agent (agent-session.md §A2.3 `<times>`, §A2.6 expiry).

import { T } from "../i18n/index.ts";
import { formatShortDuration } from "../util/duration.ts";

/** Clocks the agent reads; tests pass fake ones. Both in milliseconds. */
export interface Clock {
  /** A monotonic clock (performance.now): doesn't jump, may stop while the machine sleeps. */
  mono(): number;
  /** The wall clock (Date.now): counts sleep, may jump. */
  wall(): number;
}

export const systemClock: Clock = {
  mono: () => performance.now(),
  wall: () => Date.now(),
};

/** A point in time on both clocks. */
export interface Instant {
  mono: number;
  wall: number;
}

export function now(clock: Clock): Instant {
  return { mono: clock.mono(), wall: clock.wall() };
}

/**
 * `elapsed(a, now) = max(monotonic difference, wall-clock difference)` (§A2.6): time while
 * the machine sleeps counts, and a wall clock set back doesn't make the agent live longer.
 */
export function elapsedMs(since: Instant, at: Instant): number {
  return Math.max(at.mono - since.mono, at.wall - since.wall);
}

function toNumber(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

/**
 * `<times>` (§A2.3): `the agent (pid <n>) exits in <D>` when idle_left ≥ max_left, else
 * `the agent (pid <n>) exits in <D1> if unused, in <D2> at the latest`.
 */
export function formatAgentTimes(pid: number | bigint, idleLeftMs: number | bigint, maxLeftMs: number | bigint): string {
  const idle = toNumber(idleLeftMs);
  const max = toNumber(maxLeftMs);
  const p = typeof pid === "bigint" ? pid : BigInt(Math.trunc(pid));
  if (idle >= max) return T("the agent (pid %d) exits in %s", p, formatShortDuration(max));
  return T("the agent (pid %d) exits in %s if unused, in %s at the latest", p, formatShortDuration(idle), formatShortDuration(max));
}
