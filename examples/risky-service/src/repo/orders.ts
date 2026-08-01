/** Order persistence. Both handlers below discard their failures. */
export async function persistOrder(order) {
  try {
    await db.orders.insert(order);
  } catch (e) {}
}

export async function loadOrder(id) {
  try {
    return await db.orders.findUnique(id);
  } catch (e) {
    return null;
  }
}
