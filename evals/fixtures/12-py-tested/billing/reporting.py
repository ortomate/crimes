"""Report assembly. Covered only by a test file that asserts nothing."""

from billing.ledger import post_entry


def build_report(account, region):
    entry = post_entry(account["account"], 100, region)
    return {
        "account": account["account"],
        "region": region,
        "lines": [entry],
        "total": entry["gross"],
    }


def export_report(report, fmt):
    if fmt == "csv":
        return "account,total\n%s,%.2f" % (report["account"], report["total"])
    if fmt == "json":
        return {"account": report["account"], "total": report["total"]}
    raise ValueError("unsupported format: %s" % fmt)
