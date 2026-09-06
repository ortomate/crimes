export async function sendBatch(items,send) { return Promise.all(items.map(item=>send(item))); }
