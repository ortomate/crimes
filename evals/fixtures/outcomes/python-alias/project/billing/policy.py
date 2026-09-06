def can_refund(role, suspended=False):
    return role == "admin" and not suspended
