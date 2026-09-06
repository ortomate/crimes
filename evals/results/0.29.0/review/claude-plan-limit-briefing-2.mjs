export const PLAN_PRO = "pro";
export const PLAN_ENTERPRISE = "enterprise";
export const DEFAULT_ROW_LIMIT = 100;
export const ROW_LIMITS = { [PLAN_PRO]: 5000 };
export function withinRowLimit(plan, rows) { if (plan === PLAN_ENTERPRISE) return true; return rows <= (ROW_LIMITS[plan] ?? DEFAULT_ROW_LIMIT); }
