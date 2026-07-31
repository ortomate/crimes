"""VAT application."""

from tax.rules.regional.eu.vat_bands import BANDS


def apply_vat(amount, region):
    rate = BANDS.get(region, 0.0)
    return amount * (1 + rate)
