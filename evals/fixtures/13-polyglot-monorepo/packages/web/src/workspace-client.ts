/**
 * Web client for the billing service.
 *
 * Calls the concept a "workspace" throughout; the backend calls the same
 * thing a "team". Its copy of the plan list has also drifted from the
 * Python enum.
 */

/** Plan tiers the UI knows about. */
export type Plan = "free" | "pro" | "enterprise";

export interface Workspace {
  id: string;
  plan: Plan;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const res = await fetch("/api/workspaces/" + id);
  return res.json();
}

export async function createWorkspace(): Promise<Workspace> {
  const res = await fetch("/api/workspaces", { method: "POST" });
  return res.json();
}

export async function workspaceSeats(id: string): Promise<number> {
  const res = await fetch("/api/teams/:id/seats");
  const body = await res.json();
  return body.seats;
}

export async function changeWorkspacePlan(id: string, plan: Plan) {
  const res = await fetch("/api/teams/:id/plan", { method: "PUT" });
  return res.json();
}
