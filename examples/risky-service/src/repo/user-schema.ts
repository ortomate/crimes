import { z } from "zod";

/** Runtime validation for the persisted user record. */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  tenantId: z.number(),
  role: z.enum(["admin", "member", "owner"]),
  plan: z.enum(["free", "pro", "enterprise"]),
  createdAt: z.string(),
});
