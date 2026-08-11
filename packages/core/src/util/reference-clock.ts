/**
 * The one clock reading a scan is allowed to take.
 *
 * Two scoring inputs depend on wall-clock time — `recency` (how long ago
 * a file was last committed) and `churn`'s window (`git log --since`) —
 * and both were reading the system clock independently. That made a scan
 * a function of *when it ran*, which is fine for a user and fatal for a
 * measurement: `evals:ranking` is documented as "deterministic, no noise
 * band, any delta is real", and two runs a fortnight apart on identical
 * code could disagree.
 *
 * `CRIMES_NOW` pins the reference. It is the same class of escape hatch
 * as `CRIMES_HOME` in `feedback/paths.ts` — a measurement affordance,
 * not configuration. Product runs leave it unset and read the clock,
 * which is correct: a user's repository really is a function of today.
 *
 * This lives in `util/` rather than beside either consumer because both
 * `scoring/build.ts` and `git/churn.ts` need it, and `build.ts` already
 * imports `collectChurn` from `churn.ts`. Putting it in either would
 * make the pair a cycle — the shape `circular_dependency` exists to
 * report, which would be an unusually poor thing for this codebase to
 * ship.
 */

/**
 * Reference "now" in epoch milliseconds, honouring `CRIMES_NOW`
 * (ISO-8601 or epoch milliseconds).
 *
 * A malformed value is **ignored** rather than parsed to `NaN` and
 * treated as epoch 0. A typo that silently pinned every scan to 1970
 * would make every file maximally stale and every churn window empty —
 * a total, silent loss of two signals, which is a worse failure than not
 * honouring the override.
 */
export function referenceNowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRIMES_NOW;
  if (raw === undefined || raw.trim() === "") return Date.now();
  const asNumber = Number(raw);
  const parsed = Number.isFinite(asNumber) ? asNumber : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Subtract a compact window (`"90d"`, `"2w"`, `"6m"`, `"1y"`) from a
 * reference instant, returning epoch milliseconds, or `undefined` when
 * the string is not a compact window.
 *
 * Months and years are **calendar** arithmetic rather than 30- and
 * 365-day approximations, so `6m` means the same date six months back
 * and not "180 days ago". Git's own phrases are calendar-aware; matching
 * that is the point of doing the arithmetic here instead of handing git
 * a relative phrase it would resolve against the system clock.
 */
export function windowStartMs(window: string, nowMs: number): number | undefined {
  const compact = /^\s*(\d+)\s*([dwmy])\s*$/i.exec(window);
  if (!compact) return undefined;
  const value = Number(compact[1]);
  const unit = compact[2]!.toLowerCase();
  const d = new Date(nowMs);
  switch (unit) {
    case "d":
      d.setUTCDate(d.getUTCDate() - value);
      return d.getTime();
    case "w":
      d.setUTCDate(d.getUTCDate() - value * 7);
      return d.getTime();
    case "m":
      d.setUTCMonth(d.getUTCMonth() - value);
      return d.getTime();
    case "y":
      d.setUTCFullYear(d.getUTCFullYear() - value);
      return d.getTime();
    default:
      return undefined;
  }
}
