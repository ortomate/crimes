"""Shared assertion helpers for the billing tests.

Neither helper is named with an assert prefix, and that is deliberate:
a same-file matcher already credits a helper that is, so a fixture
built that way would prove nothing about following a helper across
files.
"""

import unittest

from billing.invoices import build_invoice


def verify_invoice_balances(invoice):
    """Every invoice must satisfy gross == net + tax."""
    assert invoice["gross"] == invoice["net"] + invoice["tax"]
    assert invoice["net"] >= 0


class InvoiceCase(unittest.TestCase):
    """Base class carrying the assertions its subclasses call."""

    def expect_gross_for(self, account, amounts, region, expected):
        invoice = build_invoice(account, amounts, region)
        self.assertAlmostEqual(invoice["gross"], expected)
        self.assertEqual(invoice["account"], account)
