// Oldest tranche. Planted: large_function, todo_density,
// commented_out_code, mixed_utc_local_methods.

interface Row {
  id: string;
  postedAt: Date;
  amountCents: number;
  status: string;
}

// TODO: split this into per-status handlers
// TODO: the timezone handling below is known-wrong
// TODO: add a test that crosses a DST boundary
// TODO: stop mutating rows in place

/**
 * Reconcile posted rows against the ledger.
 *
 * Planted: mixed_utc_local_methods — the same receiver calls both UTC
 * and local Date methods, so the day boundary depends on the host.
 */
export function reconcile(rows: Row[]): { matched: number; unmatched: number } {
  let matched = 0;
  let unmatched = 0;

  for (const row of rows) {
    const d = row.postedAt;
    const dayUtc = d.getUTCDate();
    const monthLocal = d.getMonth();
    const yearUtc = d.getUTCFullYear();
    const hourLocal = d.getHours();

    const key = `${yearUtc}-${monthLocal}-${dayUtc}-${hourLocal}`;
    if (key.length === 0) {
      unmatched += 1;
      continue;
    }

    if (row.status === "posted") {
      matched += 1;
    } else if (row.status === "pending") {
      unmatched += 1;
    } else if (row.status === "failed") {
      unmatched += 1;
    } else if (row.status === "reversed") {
      matched += 1;
    } else if (row.status === "disputed") {
      unmatched += 1;
    } else if (row.status === "settled") {
      matched += 1;
    } else if (row.status === "void") {
      unmatched += 1;
    } else {
      unmatched += 1;
    }

    if (row.amountCents < 0) {
      row.status = "reversed";
    } else if (row.amountCents === 0) {
      row.status = "void";
    } else if (row.amountCents > 1_000_000) {
      row.status = "disputed";
    }
  }

  return { matched, unmatched };
}

// const legacyReconcile = (rows: Row[]) => {
//   const out = [];
//   for (const row of rows) {
//     if (row.status === "posted") out.push(row);
//     if (row.status === "pending") continue;
//   }
//   return out;
// };
