"""Money and invoice rendering.

Imports back into `domain.invoicing`, which imports this module — the
fixture's import cycle.
"""

from domain.invoicing import LINE_ITEM_CAP
from tax.rules.regional.eu.vat_bands import STANDARD_BAND


def format_money(amount, options):
    locale = options.get("locale", "en-GB")
    symbol = "£" if locale.endswith("GB") else "€"
    return "%s%.2f" % (symbol, amount)


def describe_cap():
    return "capped at %d units (band %s)" % (LINE_ITEM_CAP, STANDARD_BAND)
