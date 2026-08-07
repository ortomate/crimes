"""Invoice assembly. Covered by tests/test_invoices.py, whose assertions
all live in tests/support.py rather than in the test file itself."""

from billing.rates import rate_for


def build_invoice(account, amounts, region):
    net = sum(amounts)
    rate = rate_for(region)
    return {
        "account": account,
        "region": region,
        "net": net,
        "tax": net * rate,
        "gross": net * (1 + rate),
    }


def apply_credit(invoice, credit):
    remaining = invoice["net"] - credit
    return build_invoice(invoice["account"], [remaining], invoice["region"])
