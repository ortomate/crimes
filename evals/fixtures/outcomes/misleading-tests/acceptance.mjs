import assert from "node:assert/strict";import {remove} from "./src/route.js";import {canRead} from "./src/read.js";
for(const role of ["guest","member","admin"])for(const id of ["owner","other"])for(const locked of [true,false]) {let calls=0;const allowed=!locked&&(role==="admin"||id==="owner");assert.deepEqual(await remove({id,role},{id:"doc",ownerId:"owner",locked},{delete:async()=>calls++}),{status:allowed?204:403});assert.equal(calls,allowed?1:0);}
assert.equal(canRead({id:"g"},{ownerId:"u",public:true}),true);
