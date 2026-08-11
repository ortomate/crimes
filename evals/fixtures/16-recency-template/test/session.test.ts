// Test tranche: committed 9 days before the reference date, so recency
// has partly decayed (~0.71).
//
// Planted: weak_test_signal — two tests that assert nothing meaningful.

import { describe, expect, it } from "vitest";
import { openBasket, subtotalCents } from "../src/checkout/basket.js";

describe("basket", () => {
  it("opens a basket", () => {
    const b = openBasket("t_1");
    expect(b).toBeTruthy();
  });

  it("computes a subtotal", () => {
    const b = openBasket("t_1");
    b.lines.push({ sku: "seat", quantity: 2, unitCents: 1800 });
    subtotalCents(b);
  });

  it("is defined", () => {
    expect(openBasket).toBeDefined();
  });
});
