from billing.api import request_refund
from billing.jobs import run_refund
from billing.exports import can_export
for role in ["owner", "admin", "member", ""]:
    for suspended in [True, False]:
        allowed = role in {"owner", "admin"} and not suspended
        assert request_refund(role, suspended) == {"accepted": allowed}
        assert run_refund(role, suspended) == ("queued" if allowed else "denied")
assert not can_export("owner")
assert can_export("admin")
