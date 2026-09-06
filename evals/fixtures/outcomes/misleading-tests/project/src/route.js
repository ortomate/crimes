import {canDelete} from "./access.js"; export async function remove(user,doc,store) { if(!canDelete(user,doc)) return {status:403}; await store.delete(doc.id); return {status:204}; }
