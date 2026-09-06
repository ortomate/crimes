export async function refund(db, analytics, id) { await db.insertRefund(id); try { await analytics.emit("refund",id); } catch {} return {ok:true,id}; }
