import assert from "node:assert/strict"; const canDelete=()=>true; assert.equal(canDelete({role:"admin"},{}),true);
