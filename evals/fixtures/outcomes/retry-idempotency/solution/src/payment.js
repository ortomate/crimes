import {retry} from "./retry.js";export async function pay(gateway,uuid,amount) { const idempotencyKey=uuid();return retry(()=>gateway.charge({amount,idempotencyKey}),3); }
