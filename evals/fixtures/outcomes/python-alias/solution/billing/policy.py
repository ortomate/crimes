def can_refund(role, suspended=False):
    return role in {"admin", "owner"} and not suspended
