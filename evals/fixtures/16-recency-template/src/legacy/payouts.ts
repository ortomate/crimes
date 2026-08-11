// Oldest tranche — recency 0, and where the repository's genuinely
// worst finding lives.
//
// Planted: unsafe_retry on a payout (a second, more dangerous one than
// settlement.ts), swallowed_error, direct_date, commented_out_code.

interface Payout {
  id: string;
  destination: string;
  amountCents: number;
}

// TODO: this needs an idempotency key before the next audit
// TODO: nobody has owned this file since the migration

/**
 * Send a payout, retrying on failure.
 *
 * The retry replays a money movement with no key the receiver can
 * deduplicate on, so a timeout after the provider has committed pays
 * the destination twice.
 */
export async function sendPayout(payout: Payout): Promise<boolean> {
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    try {
      const res = await fetch("https://payouts.internal/v1/send", {
        method: "POST",
        body: JSON.stringify({
          destination: payout.destination,
          amountCents: payout.amountCents,
          at: Date.now(),
        }),
      });
      if (res.ok) return true;
    } catch {
      // swallowed: the caller cannot tell a failure from a refusal
    }
  }
  return false;
}

// export async function sendPayoutV1(payout: Payout) {
//   const res = await fetch("https://payouts.internal/send", {
//     method: "POST",
//     body: JSON.stringify(payout),
//   });
//   if (!res.ok) throw new Error("payout failed");
//   return res.json();
// }

/** Planted: boolean_naming_drift. */
export const payout: boolean = false;
