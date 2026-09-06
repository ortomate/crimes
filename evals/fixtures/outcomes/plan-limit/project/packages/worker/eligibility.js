export function canQueue(plan, rows) { if (plan === "enterprise") return true; if (plan === "pro") return rows <= 1000; return rows <= 100; }
