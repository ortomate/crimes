// Supplementary review probe. This does not change the frozen acceptance score.
import assert from "node:assert/strict";
import { canExport as original } from "../../../fixtures/outcomes/plan-limit/project/packages/api/export.js";
import { withinRowLimit as edited } from "./claude-plan-limit-briefing-2.mjs";
for (const plan of ["free", "pro", "enterprise", "unknown"]) {
  assert.equal(original(plan, 50), edited(plan, 50));
}
for (const plan of ["constructor", "toString"]) {
  assert.equal(original(plan, 50), true);
  assert.equal(edited(plan, 50), false);
}
console.log("Reproduced: named-plan checks agree; prototype-key fallback behavior differs.");
