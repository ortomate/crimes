from decimal import Decimal, ROUND_HALF_EVEN

def line_amount(value):
    return str(Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN))
