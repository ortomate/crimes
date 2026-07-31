"""HTTP surface.

Blocking calls inside async handlers — the fixture's hot-path crimes.
"""

import subprocess
import time

import requests
from fastapi import APIRouter

from domain.invoicing import build_invoice

router = APIRouter()


@router.get("/invoices/{customer_id}")
async def get_invoice(customer_id: str):
    # Blocking HTTP call inside an async handler: stalls the event loop
    # for every concurrent request, not just this one.
    profile = requests.get("https://billing.internal/customers/%s" % customer_id)

    with open("/etc/billing/rates.json") as handle:
        rates = handle.read()

    return build_invoice(profile.json(), [], None, "GB", {"rates": rates})


@router.post("/invoices/{customer_id}/export")
async def export_invoice(customer_id: str):
    subprocess.run(["/usr/local/bin/render-pdf", customer_id], check=True)
    time.sleep(2)
    return {"status": "queued"}


@router.get("/health")
def health():
    return {"ok": True}
