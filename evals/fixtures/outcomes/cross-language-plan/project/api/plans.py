from enum import Enum

class Plan(str, Enum):
    FREE="free"
    TEAM="team"
    ENTERPRISE="enterprise"

def parse_plan(value):
    return Plan(value).value
