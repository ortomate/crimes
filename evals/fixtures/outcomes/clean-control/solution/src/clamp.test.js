import assert from "node:assert/strict";import {clamp} from "./clamp.js";assert.equal(clamp(-1),0);assert.equal(clamp(101),100);assert.equal(clamp(50),50);assert.equal(clamp(20,10),10);
