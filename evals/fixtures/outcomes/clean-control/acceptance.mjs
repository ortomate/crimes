import assert from "node:assert/strict";import {clamp} from "./src/clamp.js";
for(const [value,upper,expected] of [[20,10,10],[-1,10,0],[5,10,5],[1,0,0],[101,undefined,100],[-1,undefined,0],[50,undefined,50]])assert.equal(clamp(value,upper),expected);
