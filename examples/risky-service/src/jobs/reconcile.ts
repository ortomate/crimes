/** Nightly reconciliation. The queue publish is fire-and-forget. */
export function reconcile(orders) {
  for (const order of orders) {
    queue.publish(order).catch(() => {});
  }
}

export async function archiveOld(orders) {
  try {
    await db.orders.updateMany({ archived: true });
  } catch (e) {
    logger.error("archive failed");
  }
}
