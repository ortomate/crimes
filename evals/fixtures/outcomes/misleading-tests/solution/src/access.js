export function canDelete(user,doc) { if(doc.locked) return false; return user.role === "admin" || user.id === doc.ownerId; }
