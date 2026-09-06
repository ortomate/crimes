from decimal import Decimal
from .money import line_amount

def total(values):
    return str(sum((Decimal(line_amount(v)) for v in values), Decimal("0.00")))
