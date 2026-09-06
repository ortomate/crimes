import assert from "node:assert/strict"; import {canDelete} from "./access.js"; assert.equal(canDelete({id:"g",role:"guest"},{ownerId:"u",locked:false}),false);
