/**
 * The API's view of a user. Hand-maintained alongside the persistence
 * schema in `repo/user-schema.ts` — the two have drifted.
 */
export interface User {
  id: string;
  email: string;
  tenantId: string;
  role: "admin" | "member";
  plan: "free" | "pro";
  createdAt: Date;
}

export interface UserSummary {
  id: string;
  email?: string;
  role: string;
}
