// Newest tranche: committed 3 days before the reference date, so every
// finding here carries recency 1.0 — the maximum boost.
//
// This is the feature under active development, which is the case the
// recency multiplier is presumably for.

/**
 * Planted: contract_drift against `core/types.ts` — the same concept,
 * declared twice, and the two declarations disagree. The checkout copy
 * has drifted ahead: it carries `currency` and `discountCents`, which
 * the core one has never heard of.
 */
export interface Basket {
  id: string;
  tenant: string;
  currency: string;
  discountCents: number;
  lines: BasketLine[];
}

export interface BasketLine {
  sku: string;
  quantity: number;
  unitCents: number;
}

/** Planted: direct_date — the checkout clock read. */
export function openBasket(tenant: string): Basket {
  return {
    id: `bk_${Date.now()}`,
    tenant,
    currency: "USD",
    discountCents: 0,
    lines: [],
  };
}

/** Planted: boolean_naming_drift — `checkout` reads as a noun. */
export const checkout: boolean = true;

export function subtotalCents(basket: Basket): number {
  return basket.lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
}
