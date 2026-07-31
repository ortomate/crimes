"""HTTP surface for billing."""

from fastapi import APIRouter

from billing.plans import Plan, seats_for

router = APIRouter()


@router.get("/api/teams/{team_id}")
def get_team(team_id: str):
    return {"id": team_id, "plan": Plan.FREE}


@router.post("/api/teams")
def create_team(payload: dict):
    return {"id": "t_1", "plan": Plan.FREE}


@router.get("/api/teams/{team_id}/seats")
def team_seats(team_id: str):
    return {"seats": seats_for(Plan.FREE)}


@router.post("/api/teams/{team_id}/plan")
def change_team_plan(team_id: str, plan: str):
    return {"id": team_id, "plan": plan}
