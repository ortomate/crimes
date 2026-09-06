from .policy import can_refund

def run_refund(role, suspended=False):
    return "queued" if can_refund(role, suspended) else "denied"
