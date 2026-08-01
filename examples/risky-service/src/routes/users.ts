import { createUser as createUserService } from "../services/users.js";

export function createUser(user) {
  return createUserService(user);
}
