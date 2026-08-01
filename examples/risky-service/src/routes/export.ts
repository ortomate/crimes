import { loadBillingExport } from "../services/billing.js";

/**
 * Export handler. The entitlement rule below is also implemented in
 * `services/entitlements.ts`; neither delegates to the other.
 */
export async function exportBilling(user, res) {
  if (user.role === "admin" && user.plan !== "free") {
    return res.send(await loadBillingExport(user.tenantId));
  }
  return res.status(403).end();
}
