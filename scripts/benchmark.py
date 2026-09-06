#!/usr/bin/env python3
"""Measure real CLI processes on a fixed corpus. No agent calls or network.

python3 scripts/benchmark.py --cli packages/cli/dist/index.js \
  --cases /tmp/cases.json --output /tmp/performance.json --repeats 10

Cases: [{"id":"service", "root":"/absolute/root", "target":"src/api.ts"}].
Run baseline/candidate on the SAME source directories and Node executable.
First means first measured process, NOT flushed OS disk cache. Every repeated
sample also starts a fresh CLI; stage timings are nested, not additive.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


def worker(spec):
    """One worker per CLI process gives that child's own peak RSS."""
    with tempfile.TemporaryDirectory(prefix="crimes-perf-") as temp:
        phases = Path(temp) / "phases.json"
        output = Path(temp) / "stdout"
        env = {**os.environ, "CI": "true", "CRIMES_BENCH_PHASES": str(phases), "CRIMES_NOW": spec["reference_clock"]}
        started = time.perf_counter()
        with output.open("w") as stdout:
            result = subprocess.run(spec["command"], cwd=spec["root"], env=env,
                                    input=spec.get("input"), text=True, stdout=stdout,
                                    stderr=subprocess.PIPE, timeout=180)
        elapsed = (time.perf_counter() - started) * 1000
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        report = json.loads(output.read_text()) if result.returncode == 0 else None
        if result.returncode:
            raise RuntimeError(f"CLI exited {result.returncode}: {result.stderr}")
        normalized = json.dumps(report, sort_keys=True).replace(spec["root"], "<root>")
        return {"elapsed_ms": round(elapsed, 3),
                "peak_rss_bytes": rss if sys.platform == "darwin" else rss * 1024,
                "report_sha256": hashlib.sha256(normalized.encode()).hexdigest(),
                "phases": json.loads(phases.read_text()) if phases.exists() else {},
                "files_analyzed": report.get("coverage", {}).get("files_total"),
                "findings": len(report["findings"]) if "findings" in report else None}


def source_digest(root):
    digest = hashlib.sha256()
    count = 0
    for base, directories, files in os.walk(root):
        directories[:] = sorted(d for d in directories if d not in
                                {".git", "node_modules", "dist", "__pycache__", ".astro"})
        for name in sorted(files):
            path = Path(base) / name
            if path.is_symlink() or name == ".git":
                continue
            digest.update(str(path.relative_to(root)).encode() + b"\0")
            digest.update(path.read_bytes())
            count += 1
    return {"sha256": digest.hexdigest(), "files": count}


def percentile(values, proportion):
    return sorted(values)[max(0, math.ceil(len(values) * proportion) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--cases", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--now", default="2026-09-07T00:00:00Z")
    parser.add_argument("--repeats", type=int, default=10)
    parser.add_argument("--commands", default="scan,context,hook")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(json.loads(args.worker.read_text()))))
        return
    if not all([args.cli, args.cases, args.output]) or args.repeats < 2:
        parser.error("--cli, --cases, --output and --repeats >= 2 required")
    cli = args.cli.resolve()
    observer = Path(__file__).with_name("performance-observer.mjs").resolve()
    rows = []
    result = {"method": "first measured plus repeated fresh CLI processes; OS cache not flushed; nested phase totals",
              "node": subprocess.check_output([args.node, "--version"], text=True).strip(),
              "platform": platform.platform(), "cpu": platform.processor(),
              "logical_cpus": os.cpu_count(), "cli_sha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
              "repeats": args.repeats, "reference_clock": args.now, "rows": rows}
    for case in json.loads(args.cases.read_text()):
        root = str(Path(case["root"]).resolve())
        before = source_digest(Path(root))
        for command in args.commands.split(","):
            options = {"scan": ["scan", root, "--format", "json"],
                       "context": ["context", case["target"], "--root", root, "--format", "json"],
                       "hook": ["hook", "--format", "claude"]}[command]
            spec = {"root": root, "reference_clock": args.now, "command": [args.node, "--import", str(observer), str(cli), *options]}
            if command == "hook":
                spec["input"] = json.dumps({"hook_event_name": "PreToolUse", "cwd": root,
                                            "tool_input": {"file_path": case["target"]}})
            samples = []
            with tempfile.TemporaryDirectory(prefix="crimes-perf-spec-") as temp:
                path = Path(temp) / "spec.json"
                path.write_text(json.dumps(spec))
                for _ in range(args.repeats + 1):
                    row = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", str(path)],
                                         text=True, capture_output=True, timeout=200, check=True)
                    samples.append(json.loads(row.stdout))
            repeated = [s["elapsed_ms"] for s in samples[1:]]
            rows.append({"case": case["id"], "command": command, "source": before,
                         "first_ms": samples[0]["elapsed_ms"], "median_ms": statistics.median(repeated),
                         "p95_ms": percentile(repeated, .95), "peak_rss_bytes": max(s["peak_rss_bytes"] for s in samples),
                         "stable_report": len({s["report_sha256"] for s in samples}) == 1,
                         "samples": samples})
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            print(f"{case['id']} {command}: median {statistics.median(repeated):.0f}ms; p95 {percentile(repeated, .95):.0f}ms", flush=True)
        if source_digest(Path(root)) != before:
            raise RuntimeError(f"Corpus changed while measuring: {case['id']}")


if __name__ == "__main__":
    main()
