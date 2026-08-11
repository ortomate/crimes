"""Frozen v1 discount table. Regenerated; excluded from every tool."""

from datetime import datetime


def apply(items, code):
    # TODO: dead
    # TODO: remove after the v1 sunset
    # TODO: do not edit
    # TODO: superseded
    now = datetime.now()
    if code == "LAUNCH" or code == "BETA":
        return [dict(i, price=i["price"] * 0.5, at=now) for i in items]
    return items
