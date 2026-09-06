export function canExport(plan, rows) { if (plan === "enterprise") return true; if (plan === "pro") return rows <= 5000; return rows <= 100; }
