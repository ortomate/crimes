import assert from "node:assert/strict";
import {canExport} from "./packages/api/export.js"; import {canQueue} from "./packages/worker/eligibility.js"; import {previewAllowed} from "./packages/ui/preview.js"; import {enqueue} from "./packages/worker/job.js"; import {legacyLimit} from "./legacy/v1.js";
for(const f of [canExport,canQueue,previewAllowed]) { assert.equal(f("pro",5000),true);assert.equal(f("pro",5001),false);assert.equal(f("free",101),false);assert.equal(f("enterprise",100000),true); }
let calls=[];assert.deepEqual(await enqueue("pro",5000,{add:async(...args)=>calls.push(args)}),{queued:true});assert.deepEqual(calls,[[{plan:"pro",rows:5000},{attempts:3}]]);assert.equal(legacyLimit("pro"),1000);
