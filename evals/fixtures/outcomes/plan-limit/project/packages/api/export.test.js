import assert from "node:assert/strict"; import {canExport} from "./export.js"; assert.equal(canExport("free",101),false); assert.equal(canExport("pro",1000),true);
