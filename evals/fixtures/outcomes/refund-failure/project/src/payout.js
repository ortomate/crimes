export async function payout(db,id) { try { await db.insertPayout(id); } catch {} return {ok:true,id}; }
