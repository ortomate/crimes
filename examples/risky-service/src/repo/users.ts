import { persistUser } from "./user-store.js";

export function saveUser(user) {
  return persistUser(user);
}
