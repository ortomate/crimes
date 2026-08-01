import { saveUser } from "../repo/users.js";

export function createUserService(user) {
  return saveUser(user);
}
