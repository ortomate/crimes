import assert from "node:assert/strict";import {execFileSync} from "node:child_process";import {plans,isPaid} from "./web/plans.js";import {historicalPlans} from "./audit/labels.js";
assert.deepEqual(plans,["free","business","enterprise"]);assert.equal(isPaid("business"),true);assert.equal(isPaid("team"),false);assert.equal(isPaid("free"),false);assert.equal(isPaid("enterprise"),true);assert.deepEqual(historicalPlans,["free","team","enterprise"]);
execFileSync("python3",["-c",`from api.plans import parse_plan
assert parse_plan("business")=="business"
assert parse_plan("free")=="free"
assert parse_plan("enterprise")=="enterprise"
try:
 parse_plan("team")
except ValueError:
 pass
else:
 raise AssertionError("legacy accepted")`]);
