/** Entitlement checks used by the worker path. */
export function canExportBilling(member) {
  if (member.role === "admin" && member.plan !== "free") {
    return true;
  }
  return false;
}

export function canManageSeats(member) {
  if (member.role === "owner" && member.plan !== "free") {
    return true;
  }
  return false;
}
