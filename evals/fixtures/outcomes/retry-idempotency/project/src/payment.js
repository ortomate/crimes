import {retry} from "./retry.js";export async function pay(gateway,uuid,amount) { return retry(()=>gateway.charge({amount,idempotencyKey:uuid()}),3); }
