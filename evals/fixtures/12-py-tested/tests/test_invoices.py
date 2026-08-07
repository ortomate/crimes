"""Tests for billing.invoices.

Every assertion in this file is made somewhere else — either in
verify_invoice_balances or on the InvoiceCase base class, both in
tests/support.py. That is the dominant Python test idiom, and it is
why this file reads as silent to anything that only looks inside the
test function's own line span.
"""

from billing.invoices import apply_credit, build_invoice
from support import InvoiceCase, verify_invoice_balances


def test_invoice_totals_balance():
    verify_invoice_balances(build_invoice("acct_1", [1000, 250], "GB"))


def test_credit_reduces_the_total():
    invoice = build_invoice("acct_2", [4000], "DE")
    verify_invoice_balances(apply_credit(invoice, 500))


def test_zero_credit_is_a_no_op():
    invoice = build_invoice("acct_3", [750], "FR")
    verify_invoice_balances(apply_credit(invoice, 0))


class InvoiceGrossTests(InvoiceCase):
    def test_gross_includes_vat(self):
        self.expect_gross_for("acct_4", [1000], "GB", 1200.0)

    def test_gross_for_a_zero_line_invoice(self):
        self.expect_gross_for("acct_5", [], "DE", 0.0)
