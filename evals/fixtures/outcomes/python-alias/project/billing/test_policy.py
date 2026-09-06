from .policy import can_refund

def test_admin():
    assert can_refund("admin")
