export async function retry(operation,attempts) { let last;for(let i=0;i<attempts;i++){try{return await operation();}catch(error){last=error;}}throw last; }
