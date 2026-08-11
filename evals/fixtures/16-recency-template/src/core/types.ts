// Middle tranche. Planted: contract_drift against checkout/basket.ts,
// and singular_plural_type_mismatch.

export interface Basket {
  id: string;
  tenant: string;
}

export interface Charge {
  id: string;
  amountCents: number;
}

/** Planted: singular_plural_type_mismatch — plural name, singular type. */
export const baskets: Basket = { id: "b_1", tenant: "t_1" };

/** Planted: singular_plural_type_mismatch — singular name, array type. */
export const charge: Charge[] = [];
