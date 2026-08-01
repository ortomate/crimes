/** The central configuration module. Not everyone goes through it. */
export const port = Number(process.env.PORT ?? "3000");
export const databaseUrl = process.env.DATABASE_URL!;
export const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? "5000");
export const queueName = process.env.LEGACY_QUEUE_NAME ?? "default";
