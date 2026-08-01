import chalk from "chalk";

/**
 * Payment submission with a retry loop.
 *
 * The retry replays a POST with no idempotency key: an attempt that
 * succeeded on the server but timed out on the way back is charged twice.
 */
const timeoutSeconds = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30", 10);

export async function submitPayment(order) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.post("/charges", {
        amount: order.total,
        timeout: timeoutSeconds,
      });
    } catch (e) {
      continue;
    }
  }
  console.log(chalk.red("payment failed"));
}

export async function refundPayment(order) {
  return withRetry(async () => stripe.refunds.create({ charge: order.chargeId }), {
    retries: 5,
  });
}
