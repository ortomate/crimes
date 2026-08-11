// Newest tranche — recency 1.0.
//
// Planted: large_function, swallowed_error, todo_density,
// magic_domain_literal_scatter, sync_io_in_hotpath.

import { readFileSync } from "node:fs";
import { endpoint } from "../core/config.js";
import { type Basket, subtotalCents } from "./basket.js";

// TODO: extract the tax branch into its own module
// TODO: the currency table below should come from config
// TODO: this handler is doing four jobs

interface SessionResult {
  sessionId: string;
  totalCents: number;
  currency: string;
  warnings: string[];
}

/**
 * Create a checkout session.
 *
 * Deliberately long and mixed: quote, tax, discount, persistence and
 * telemetry in one body, with a synchronous read on the request path.
 */
export async function createSession(
  basket: Basket,
  actor: { role: string; plan: string },
): Promise<SessionResult> {
  const warnings: string[] = [];

  // sync_io_in_hotpath: a blocking read per request.
  const taxTable = JSON.parse(readFileSync("./tax-table.json", "utf8")) as Record<
    string,
    number
  >;

  let total = subtotalCents(basket);

  if (basket.currency === "USD") {
    total = Math.round(total * 1.0);
  } else if (basket.currency === "EUR") {
    total = Math.round(total * 1.09);
  } else if (basket.currency === "GBP") {
    total = Math.round(total * 1.27);
  } else if (basket.currency === "JPY") {
    total = Math.round(total * 157.0);
  } else {
    warnings.push(`unknown currency ${basket.currency}`);
  }

  const rate = taxTable[basket.tenant] ?? 0;
  if (rate > 0) {
    total = Math.round(total * (1 + rate));
  }

  if (actor.plan === "enterprise") {
    total = Math.round(total * 0.9);
  } else if (actor.plan === "pro") {
    total = Math.round(total * 0.95);
  }

  if (basket.discountCents > 0) {
    total = Math.max(0, total - basket.discountCents);
  }

  if (total < 0) {
    warnings.push("negative total clamped");
    total = 0;
  }

  let sessionId = "";
  try {
    const res = await fetch(endpoint("/sessions"), {
      method: "POST",
      body: JSON.stringify({ basket: basket.id, total }),
    });
    sessionId = (await res.json()).id as string;
  } catch {
    // Planted: swallowed_error — the caller is told nothing failed.
  }

  return { sessionId, totalCents: total, currency: basket.currency, warnings };
}

/** Planted: magic_domain_literal_scatter — "enterprise" again. */
export function isEnterpriseSession(plan: string): boolean {
  return plan === "enterprise";
}
