/** Tiny executable change tasks. Acceptance checks are installed only after the edit. */
export interface OutcomeCase {
  id: string;
  target: string;
  task: string;
  files: Record<string, string>;
  allowed: string[];
  acceptance: string;
}

export const outcomeCases: OutcomeCase[] = [
  {
    id: "policy-consumers",
    target: "src/export.js",
    task: "Increase the pro export limit from 1000 to 5000 rows everywhere it is enforced. Preserve free and enterprise behaviour and public function signatures.",
    files: {
      "src/export.js":
        'export function canExport(plan, rows) { if (plan === "enterprise") return true; if (plan === "pro") return rows <= 1000; return rows <= 100; }\n',
      "src/job.js":
        'export function canRunExport(plan, rows) { if (plan === "enterprise") return true; if (plan === "pro") return rows <= 1000; return rows <= 100; }\n',
      "src/preview.js":
        'import { canExport } from "./export.js"; export const previewAllowed = canExport;\n',
    },
    allowed: ["src/export.js", "src/job.js"],
    acceptance:
      'import { canExport } from "./src/export.js"; import { canRunExport } from "./src/job.js";\nfor (const fn of [canExport, canRunExport]) { assert.equal(fn("pro", 5000), true); assert.equal(fn("pro", 5001), false); assert.equal(fn("free", 101), false); assert.equal(fn("enterprise", 100000), true); }',
  },
  {
    id: "response-consumer",
    target: "src/user.js",
    task: "Rename the user response field name to displayName, including consumers. The displayed greeting must stay the same. Keep the exported function signatures and all unrelated response fields.",
    files: {
      "src/user.js":
        "export function userResponse(user) { return { id: user.id, name: user.name, active: true }; }\n",
      "src/greeting.js":
        'import { userResponse } from "./user.js"; export function greeting(user) { return "Hello " + userResponse(user).name; }\n',
      "src/unrelated.js": "export const version = 1;\n",
    },
    allowed: ["src/user.js", "src/greeting.js"],
    acceptance:
      'import { userResponse } from "./src/user.js"; import { greeting } from "./src/greeting.js"; const user = { id: "1", name: "Ada" }; assert.deepEqual(userResponse(user), { id: "1", displayName: "Ada", active: true }); assert.equal(greeting(user), "Hello Ada");',
  },
  {
    id: "refund-failure",
    target: "src/refund.js",
    task: "A failed refund write currently looks successful. Make failure observable by rejection to the caller, preserving the original error. Preserve the successful return shape and the single write.",
    files: {
      "src/refund.js":
        "export async function refund(db, id) { try { await db.insertRefund(id); } catch {} return { ok: true, id }; }\n",
      "src/status.js": 'export const status = "ready";\n',
    },
    allowed: ["src/refund.js"],
    acceptance:
      'import { refund } from "./src/refund.js"; let calls = 0; const ok = await refund({ insertRefund: async () => { calls++; } }, "r1"); assert.deepEqual(ok, { ok: true, id: "r1" }); assert.equal(calls, 1); const error = new Error("write failed"); await assert.rejects(refund({ insertRefund: async () => { throw error; } }, "r2"), (e) => e === error);',
  },
];
