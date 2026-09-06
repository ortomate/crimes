export const canRead=(user,doc)=>doc.public || user.id===doc.ownerId;
