// Intentionally risky legacy settlement module — fixture material.
// This is the oldest tranche: committed 90 days before the reference
// date, so every finding here carries recency 0.

interface Ledger {
  id: string;
  tenant: string;
  amountCents: number;
  currency: string;
  settledAt: number | undefined;
}

const RETRYABLE = [502, 503, 504];

/**
 * Settle a batch of ledger entries against the payment provider.
 *
 * Planted: unsafe_retry (a retried POST with no idempotency key),
 * swallowed_error, direct_date, magic_domain_literal_scatter.
 */
export async function settleBatch(entries: Ledger[]): Promise<number> {
  let settled = 0;
  for (const entry of entries) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch("https://payments.internal/settle", {
          method: "POST",
          body: JSON.stringify({
            ledgerId: entry.id,
            amount: entry.amountCents,
            currency: entry.currency,
            requestedAt: Date.now(),
          }),
        });
        if (RETRYABLE.includes(res.status)) continue;
        entry.settledAt = Date.now();
        settled += 1;
        break;
      } catch {
        // swallow and retry
      }
    }
  }
  return settled;
}

/** Planted: duplicated_role_status_plan_check — copy one of two. */
export function canSettle(actor: { role: string; plan: string }): boolean {
  return actor.role === "admin" && actor.plan !== "free";
}

/** Planted: boolean_naming_drift — reads as a noun. */
export const settlement: boolean = false;

/** Planted: magic_domain_literal_scatter — "enterprise" repeated. */
export function settlementWindowDays(plan: string): number {
  if (plan === "enterprise") return 30;
  if (plan === "pro") return 14;
  return 7;
}

export function isEnterprise(plan: string): boolean {
  return plan === "enterprise";
}

export function enterpriseGracePeriod(plan: string): number {
  return plan === "enterprise" ? 90 : 0;
}
