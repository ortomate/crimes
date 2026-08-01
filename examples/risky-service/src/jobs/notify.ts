/**
 * Notification fan-out.
 *
 * `db.orders.findMany()` is unpaginated, so the `Promise.all` below
 * starts one HTTP request per row in the table.
 */
const timeoutMs = process.env.REQUEST_TIMEOUT_MS === "true" ? 1000 : 5000;

export async function notifyEveryone() {
  const orders = await db.orders.findMany();
  return Promise.all(
    orders.map((order) => api.post("/notify", { order, timeout: timeoutMs })),
  );
}
