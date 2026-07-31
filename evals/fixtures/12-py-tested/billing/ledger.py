"""Ledger posting. Deliberately has no test file at all."""

from billing.rates import rate_for


def post_entry(account, amount, region):
    gross = amount * (1 + rate_for(region))
    return {
        "account": account,
        "net": amount,
        "gross": gross,
        "region": region,
    }


def reverse_entry(entry):
    return {
        "account": entry["account"],
        "net": -entry["net"],
        "gross": -entry["gross"],
        "region": entry["region"],
    }
