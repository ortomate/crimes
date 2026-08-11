// Middle tranche: committed 20 days before the reference date, so
// recency has decayed to 0 but churn is still live.

/** Planted: duplicated_role_status_plan_check — copy two of two. */
export function canPrice(actor: { role: string; plan: string }): boolean {
  return actor.role === "admin" && actor.plan !== "free";
}

/** Planted: direct_date in domain code. */
export function quoteExpiry(): number {
  return Date.now() + 3600_000;
}

/** Planted: boolean_naming_drift. */
export const expired = Date.now() > 0;

export function priceFor(plan: string, seats: number): number {
  if (plan === "enterprise") return seats * 4200;
  if (plan === "pro") return seats * 1800;
  return 0;
}
