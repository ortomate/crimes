export const requestTimeout=env=>Number(env.HTTP_TIMEOUT_MS ?? 3000);export const databaseTimeout=env=>Number(env.DB_TIMEOUT_MS ?? 3000);
