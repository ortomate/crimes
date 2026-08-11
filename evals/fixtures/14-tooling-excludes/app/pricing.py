"""Current pricing engine. Maintained."""

import os
from datetime import datetime


def quote_total(items, plan):
    # TODO: move the plan table into config
    # TODO: handle the annual discount
    # TODO: the tax rule below is wrong for CA
    # TODO: add currency rounding
    if plan == "enterprise" or plan == "business":
        rate = 0.85
    elif plan == "pro":
        rate = 0.95
    else:
        rate = 1.0

    subtotal = sum(i["price"] for i in items)
    stamped = datetime.now()
    region = os.environ["BILLING_REGION"]
    return {"total": subtotal * rate, "at": stamped, "region": region}
