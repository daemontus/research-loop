/**
 * Pause support shared by the agents and the control plane.
 *
 * A `PauseGate` is a clock that stops while the run is paused, plus the hooks
 * the agents need to hold model requests at a safe point:
 *
 *   - `activeNow()`  wall time minus all paused time: budgets measured with it
 *     (phase timeout, provider retry budget, wallclock budget) do not count
 *     down while paused;
 *   - `timeout()` / `sleep()`  timers in active time (suspended while paused);
 *   - `waitUntilResumed()`  resolves once the run is not paused;
 *   - `beginRequest()`  registers an in-flight model request so that pausing
 *     can interrupt it (it is retried after resume).
 *
 * The control plane is the source of truth for whether the run is paused; the
 * agents mirror it from their inbox polls (see agent/main.mjs).
 */
export class PauseGate {
  /** @param {{ now?: () => number }} [opts] */
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.paused = false;
    this.pausedSince = null;
    this.pausedTotal = 0;
    this.listeners = new Set();
    /** @type {Set<{ interrupt: () => void }>} */
    this.requests = new Set();
  }

  /**
   * Pause or unpause. `ts` is when it happened (defaults to now; replayed
   * pauses pass the logged time). Returns whether the state changed.
   */
  set(paused, ts = this.now()) {
    paused = Boolean(paused);
    if (paused === this.paused) return false;
    if (paused) {
      this.paused = true;
      this.pausedSince = ts;
      for (const r of [...this.requests]) {
        try {
          r.interrupt();
        } catch {
          // ignore
        }
      }
    } else {
      this.pausedTotal += Math.max(0, ts - this.pausedSince);
      this.paused = false;
      this.pausedSince = null;
    }
    this.#emit();
    return true;
  }

  /** Total paused time so far (including the current pause). */
  pausedMs(now = this.now()) {
    return this.pausedTotal + (this.paused ? Math.max(0, now - this.pausedSince) : 0);
  }

  /** A clock that does not advance while paused. */
  activeNow(now = this.now()) {
    return now - this.pausedMs(now);
  }

  /** Model requests currently in flight. */
  inFlight() {
    return this.requests.size;
  }

  /** @param {(gate: PauseGate) => void} fn @returns {() => void} unsubscribe */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of [...this.listeners]) {
      try {
        fn(this);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Resolves once the run is not paused (or `signal` aborts).
   * @param {AbortSignal} [signal]
   */
  waitUntilResumed(signal) {
    if (!this.paused || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        off();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const off = this.onChange(() => {
        if (!this.paused) done();
      });
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Register an in-flight model request. `interrupt` is called if the run is
   * paused before `release()`.
   * @param {() => void} interrupt
   * @returns {() => void} release
   */
  beginRequest(interrupt) {
    const entry = { interrupt };
    this.requests.add(entry);
    this.#emit();
    return () => {
      if (this.requests.delete(entry)) this.#emit();
    };
  }

  /**
   * Run `fn` after `ms` of active (unpaused) time.
   * @returns {{ clear: () => void }}
   */
  timeout(fn, ms) {
    let timer = null;
    let cleared = false;
    let deadline = this.activeNow() + Math.max(0, ms);
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (cleared || this.paused) return;
      const left = deadline - this.activeNow();
      if (left <= 0) {
        cleared = true;
        off();
        fn();
        return;
      }
      timer = setTimeout(arm, left);
      timer.unref?.();
    };
    const off = this.onChange(arm);
    arm();
    return {
      clear: () => {
        cleared = true;
        off();
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }

  /**
   * Sleep for `ms` of active time; resolves early if `signal` aborts.
   * @param {number} ms
   * @param {AbortSignal} [signal]
   */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const onAbort = () => {
        t.clear();
        resolve();
      };
      const t = this.timeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
