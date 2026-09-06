export async function refund(db, analytics, id) { try { await db.insertRefund(id); } catch {} try { await analytics.emit("refund",id); } catch {} return {ok:true,id}; }
