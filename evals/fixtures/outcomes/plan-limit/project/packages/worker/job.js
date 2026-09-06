import { canQueue } from "./eligibility.js";
export async function enqueue(plan, rows, queue) { if (!canQueue(plan, rows)) return { queued: false }; await queue.add({plan, rows}, {attempts:3}); return {queued:true}; }
