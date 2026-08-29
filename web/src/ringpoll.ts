import type { RingPollResponse } from './types';
import {
  initialRingState,
  ringPollDelayMs,
  ringReducer,
  type RingEvent,
  type RingState,
} from './ring';

/**
 * Drives ring.ts against a real clock.
 *
 * Invariants this class exists to guarantee:
 *  - exactly one timer and at most one in-flight request, ever;
 *  - a failing backend causes exponential backoff, never a hot loop;
 *  - a backend without the ringing routes silently stops the loop instead of
 *    painting an error the tester cannot act on;
 *  - a poll that resolves after stop() is discarded.
 */
export interface RingPollerDeps {
  /** One heartbeat+poll round trip. Rejects on transport failure. */
  poll(): Promise<RingPollResponse>;
  /** True when the request failed because the routes are not deployed. */
  isUnsupported(err: unknown): boolean;
  onState(state: RingState): void;
  hidden?(): boolean;
  setTimer?(fn: () => void, ms: number): number;
  clearTimer?(handle: number): void;
}

export class RingPoller {
  private state: RingState = initialRingState;
  private readonly deps: RingPollerDeps;
  private timer: number | null = null;
  private running = false;
  private inFlight = false;
  /** Bumped on every stop()/dispatch that reschedules, to void stale results. */
  private generation = 0;

  constructor(deps: RingPollerDeps) {
    this.deps = deps;
  }

  get current(): RingState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clear();
  }

  /** Feed the state machine and re-plan the loop around the new state. */
  dispatch(event: RingEvent): RingState {
    const next = ringReducer(this.state, event);
    const changed = next !== this.state;
    this.state = next;
    if (changed) this.deps.onState(next);
    this.replan();
    return next;
  }

  /** Poll immediately (used when the tab becomes visible again). */
  wake(): void {
    if (!this.running || this.inFlight) return;
    this.schedule(0);
  }

  // --- internals ----------------------------------------------------------

  private replan(): void {
    if (!this.running) return;
    if (this.inFlight) return; // the completion handler will reschedule
    const delay = ringPollDelayMs(this.state, { hidden: this.isHidden() });
    if (delay === null) {
      this.clear();
      return;
    }
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    this.clear();
    if (!this.running) return;
    if (ringPollDelayMs(this.state, { hidden: this.isHidden() }) === null) return;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    const generation = this.generation;
    this.timer = setTimer(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      void this.tick(generation);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const poll = await this.deps.poll();
      if (generation !== this.generation) return;
      this.applyAndKeepGoing({ type: 'polled', poll });
    } catch (err) {
      if (generation !== this.generation) return;
      if (this.deps.isUnsupported(err)) {
        this.applyAndKeepGoing({ type: 'unsupported' });
        return;
      }
      const message =
        err instanceof Error
          ? `Cannot check for incoming calls: ${err.message}`
          : 'Cannot check for incoming calls.';
      this.applyAndKeepGoing({ type: 'poll_failed', message });
    } finally {
      this.inFlight = false;
    }
  }

  /** dispatch() cannot reschedule while inFlight is set, so do it here. */
  private applyAndKeepGoing(event: RingEvent): void {
    const next = ringReducer(this.state, event);
    if (next !== this.state) {
      this.state = next;
      this.deps.onState(next);
    }
    this.inFlight = false;
    this.replan();
  }

  private clear(): void {
    if (this.timer === null) return;
    const clearTimer = this.deps.clearTimer ?? ((handle: number) => window.clearTimeout(handle));
    clearTimer(this.timer);
    this.timer = null;
  }

  private isHidden(): boolean {
    return this.deps.hidden?.() ?? false;
  }
}
