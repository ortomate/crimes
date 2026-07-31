"""Invoice assembly.

Intentionally crime-ridden — this is an eval fixture, not example code.
"""

from datetime import datetime

from tax.vat import apply_vat
from api.rendering import format_money


LINE_ITEM_CAP = 500


def build_invoice(customer, line_items, coupon, region, options):
    """Assemble an invoice from raw line items.

    Deliberately long, deeply nested, and full of direct clock reads.
    """
    issued = datetime.now()
    period_start = datetime.utcnow()

    subtotal = 0
    discount_total = 0
    skipped = []
    warnings = []

    for item in line_items:
        if item.get("quantity", 0) <= 0:
            skipped.append(item)
            continue

        if item.get("kind") == "subscription":
            if item.get("billing_period") == "annual":
                if item.get("prepaid"):
                    line_total = item["price"] * 12 * 0.85
                else:
                    line_total = item["price"] * 12
            else:
                line_total = item["price"]
        elif item.get("kind") == "usage":
            metered = item.get("units", 0)
            if metered > LINE_ITEM_CAP:
                warnings.append("usage above cap for %s" % item.get("sku"))
                metered = LINE_ITEM_CAP
            line_total = metered * item.get("unit_price", 0)
        else:
            line_total = item.get("price", 0) * item.get("quantity", 1)

        subtotal += line_total

    if coupon:
        expired = coupon.get("expires_at") < datetime.now()
        stackable = coupon.get("stackable", False)
        if not expired:
            if coupon.get("kind") == "percent":
                discount_total = subtotal * (coupon["value"] / 100)
            elif coupon.get("kind") == "fixed":
                discount_total = min(coupon["value"], subtotal)
            if stackable and coupon.get("bonus"):
                discount_total += coupon["bonus"]

    taxed = apply_vat(subtotal - discount_total, region)

    return {
        "customer": customer,
        "issued_at": issued,
        "period_start": period_start,
        "subtotal": subtotal,
        "discount": discount_total,
        "total": taxed,
        "display_total": format_money(taxed, options),
        "skipped": skipped,
        "warnings": warnings,
    }


def summarise(invoice):
    stale = invoice["issued_at"] < datetime.now()
    ready = invoice["total"] > 0
    return {"stale": stale, "ready": ready}
