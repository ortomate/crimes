export function persistUser(user) {
  return db.users.insert(user);
}
