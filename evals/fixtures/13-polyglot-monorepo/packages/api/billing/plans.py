"""Subscription plan definitions.

The canonical list of tiers lives here. The web client keeps its own
copy as a TypeScript union, and the two have drifted.
"""

from enum import Enum


class Plan(str, Enum):
    """The tiers a team can be on."""

    FREE = "free"
    PRO = "pro"
    TEAM = "team"
    SCALE = "scale"


SEATS_INCLUDED = {
    Plan.FREE: 1,
    Plan.PRO: 3,
    Plan.TEAM: 10,
    Plan.SCALE: 50,
}


def seats_for(plan):
    return SEATS_INCLUDED.get(plan, 1)
