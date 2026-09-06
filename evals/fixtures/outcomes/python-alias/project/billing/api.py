from .policy import can_refund as allowed

def request_refund(role, suspended=False):
    return {"accepted": allowed(role, suspended)}
