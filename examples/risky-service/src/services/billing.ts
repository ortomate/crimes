export async function loadBillingExport(tenantId) {
  return db.invoices.findMany({ where: { tenantId }, take: 100 });
}
