import { z } from "zod";

/**
 * Runtime validation for the persisted user record.
 *
 * Planted crime: this file is a Finder/iCloud conflict copy of
 * `user-schema.ts`, and it is **stale** — the `plan` field is missing
 * and `role` predates the `owner` value. Nothing in the repository says
 * which of the two is canonical, and both parse a user record without
 * complaint, so an agent asked to "add a field to the user schema" has a
 * 50% chance of editing the copy nothing imports.
 */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  tenantId: z.number(),
  role: z.enum(["admin", "member"]),
  createdAt: z.string(),
});
