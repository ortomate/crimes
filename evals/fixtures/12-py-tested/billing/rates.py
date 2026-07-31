"""Rate lookup. Well covered by tests/test_rates.py."""

DEFAULT_RATE = 0.2

RATES = {
    "GB": 0.20,
    "DE": 0.19,
    "FR": 0.20,
}


def rate_for(region):
    """Return the VAT rate for a region, falling back to the default."""
    return RATES.get(region, DEFAULT_RATE)


def is_zero_rated(region):
    return rate_for(region) == 0
