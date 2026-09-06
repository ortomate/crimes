from decimal import Decimal, ROUND_HALF_EVEN

def rounded(value):
    return str(Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN))
