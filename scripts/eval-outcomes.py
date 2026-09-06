#!/usr/bin/env python3
"""Acceptance-tested edits: no crimes / supplied briefing / installed workflow.

Without --run, verifies that every original fails and every reference solution
passes independent acceptance tests. Live runs require authenticated hosts,
explicit model ids, a packed npm artifact, and an output directory outside the
repository. They consume the hosts' subscription/quota. CI never invokes hosts.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import time
import outcome_support as helpers

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "evals/fixtures/outcomes"
ARMS = ["without", "briefing", "installed"]


def verify(cases):
    for case in cases:
        with tempfile.TemporaryDirectory(prefix="crimes-outcome-oracle-") as temp:
            root = Path(temp) / "project"
            shutil.copytree(FIXTURES / case["id"] / "project", root)
            original = helpers.acceptance(case, root, FIXTURES)
            if original["passed"]:
                raise RuntimeError(f"Vacuous acceptance: {case['id']}")
            shutil.copytree(FIXTURES / case["id"] / "solution", root, dirs_exist_ok=True)
            fixed = helpers.acceptance(case, root, FIXTURES)
            if not fixed["passed"]:
                raise RuntimeError(f"Broken acceptance/solution {case['id']}: {fixed['output']}")
    print(f"{len(cases)} tasks reject original source and accept reference solutions", flush=True)


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def trial(case, host, arm, repeat, args, installed, tools):
    key = f"{host}-{case['id']}-{arm}-{repeat}"
    output = args.output_dir / key
    if args.resume and (output / "result.json").exists():
        return json.loads((output / "result.json").read_text())
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crimes-outcome-edit-") as temp:
        root = Path(temp).resolve() / "project"
        shutil.copytree(FIXTURES / case["id"] / "project", root)
        # Identical available package and scanner config in all arms. Only the
        # installed arm receives generated skills and the supported Claude hook.
        (root / "crimes.config.json").write_text(json.dumps({
            "include": ["**/*.js", "**/*.ts", "**/*.py"],
            "exclude": ["**/node_modules/**", "**/.git/**", ".outcome-*"]}) + "\n")
        cli_log = output / "cli.jsonl"
        binary = helpers.install_wrapper(root, installed, cli_log)
        setup_started = time.monotonic()
        env = {**os.environ, "CI": "true", "CRIMES_NOW": "2026-09-07T00:00:00Z"}
        if arm == "installed":
            flag = "--codex-skill" if host == "codex" else "--agent-skill"
            helpers.run([binary, "init", flag], root, env=env)
        cli_log.unlink(missing_ok=True)  # Setup is not agent activation.
        helpers.run(["git", "init", "-q"], root)
        helpers.run(["git", "add", "."], root)
        helpers.run(["git", "-c", "user.name=Outcome trial", "-c", "user.email=outcomes@example.invalid",
                     "commit", "-qm", "fixture"], root)
        setup_ms = round((time.monotonic() - setup_started) * 1000)
        before = helpers.inventory(root)
        original_source = helpers.source_digest(root)
        started = time.monotonic()
        briefing = ""
        if arm == "briefing":
            briefing = helpers.run([binary, "context", case["target"], "--root", root,
                                    "--format", "json"], root, timeout=120, env=env).stdout
            (output / "briefing.json").write_text(briefing.replace(str(root), "<workspace>"))
            cli_log.unlink(missing_ok=True)  # Supplied context is not agent tool use.
        prompt = (case["task"] + "\nImplement and verify the change. Review change risk and keep the edit scoped. "
                  "Work only in this project; do not access the network, download tools, change package/config/skill files, or commit. "
                  "Use temporary storage outside scanned sources for working reports. Independent acceptance tests will run afterward.")
        if arm != "installed":
            prompt += " Do not invoke crimes separately."
        if briefing:
            prompt += "\nPre-edit briefing:\n" + briefing
        model = args.codex_model if host == "codex" else args.claude_model
        command = helpers.host_command(host, model, prompt, root)
        execution = helpers.invoke(command, root, tools, output, args.timeout)
        task_elapsed_ms = round((time.monotonic() - started) * 1000)
        after = helpers.inventory(root)
        final_source = helpers.source_digest(root)
        changed = sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))
        outside = [path for path in changed if path not in case["allowed"]]
        # Additional tests can be sensible scope changes. Flag them for review,
        # never silently equate an allow-list miss with a behavioral regression.
        diff = helpers.run(["git", "diff", "--binary", "HEAD"], root).stdout
        (output / "change.diff").write_text(diff.replace(str(root), "<workspace>"))
        for path in changed:
            if path not in before:
                destination = output / "new-files" / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                if (root / path).is_symlink():
                    destination.write_text("symlink:" + os.readlink(root / path))
                else:
                    shutil.copyfile(root / path, destination)
        acceptance = helpers.acceptance(case, root, FIXTURES)
        metrics = helpers.transcript_metrics(output / "host.jsonl", host)
        result = {"id": key, "case": case["id"], "holdout": case["holdout"], "host": host,
                  "arm": arm, "repeat": repeat, "requested_model": model, **execution, **metrics,
                  "setup_ms": setup_ms, "task_elapsed_ms": task_elapsed_ms,
                  "original_source": original_source, "final_source": final_source,
                  "acceptance_passed": acceptance["passed"], "acceptance": acceptance,
                  "changed_files": changed, "outside_expected_scope": outside,
                  **helpers.cli_metrics(cli_log, original_source, final_source)}
        result["run_success"] = result["exit_code"] == 0 and not result["timed_out"] and metrics["successful_completion_event"]
        atomic_json(output / "result.json", result)
        return result


def schedule(cases, hosts, repeats, seed):
    work = []
    positions = {case["id"]: index for index, case in enumerate(cases)}
    for repeat in range(1, repeats + 1):
        ordered = list(cases)
        random.Random(seed + repeat).shuffle(ordered)
        for index, case in enumerate(ordered):
            for h, host in enumerate(hosts):
                offset = (positions[case["id"]] + repeat + h) % len(ARMS)
                for arm in ARMS[offset:] + ARMS[:offset]:
                    work.append((case, host, arm, repeat))
    return work


def summary(rows):
    groups = []
    for host in sorted({row["host"] for row in rows}):
        for arm in ARMS:
            sample = [r for r in rows if r["host"] == host and r["arm"] == arm]
            if not sample:
                continue
            groups.append({"host": host, "arm": arm, "runs": len(sample),
                           "successful_runs": sum(r["run_success"] for r in sample),
                           "acceptance_passes": sum(r["acceptance_passed"] for r in sample),
                           "runs_needing_scope_review": sum(bool(r["outside_expected_scope"]) for r in sample),
                           "skill_actions": sum(r["skill_action_observed"] for r in sample),
                           "hook_contexts": sum(r["hook_contexts"] for r in sample),
                           "mean_task_ms": round(sum(r["task_elapsed_ms"] for r in sample)/len(sample))})
    return groups


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", action="store_true")
    p.add_argument("--package", type=Path)
    p.add_argument("--output-dir", type=Path)
    p.add_argument("--host", choices=["codex", "claude", "both"], default="both")
    p.add_argument("--codex-model")
    p.add_argument("--claude-model")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--jobs", type=int, default=2)
    p.add_argument("--timeout", type=int, default=300)
    p.add_argument("--seed", type=int, default=2900)
    p.add_argument("--cases", help="comma-separated case ids, for a pilot")
    p.add_argument("--partition", choices=["development", "holdout", "all"], default="all")
    p.add_argument("--resume", action="store_true")
    args = p.parse_args()
    cases = json.loads((REPO / "evals/outcome-cases.json").read_text())
    if args.cases:
        selected = set(args.cases.split(","))
        if selected - {c["id"] for c in cases}:
            p.error("Unknown case id")
        cases = [c for c in cases if c["id"] in selected]
    if args.partition != "all":
        cases = [c for c in cases if c["holdout"] == (args.partition == "holdout")]
    if not cases or not 1 <= args.repeats <= 10 or not 1 <= args.jobs <= 4:
        p.error("Need cases, repeats 1–10, jobs 1–4")
    verify(cases)
    if not args.run:
        return
    hosts = ["codex", "claude"] if args.host == "both" else [args.host]
    if not args.package or not args.output_dir or any(not getattr(args, host + "_model") for host in hosts):
        p.error("Live runs require --package, --output-dir and each host's explicit --HOST-model")
    args.package = args.package.resolve(strict=True)
    args.output_dir = args.output_dir.resolve()
    if args.output_dir.is_relative_to(REPO):
        p.error("Keep raw transcripts outside the repository")
    existed = args.output_dir.exists()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if existed and any(args.output_dir.iterdir()) and not args.resume:
        p.error("Output is not empty; choose a new directory or --resume")
    meta = {"format": 1, "package_sha256": helpers.digest(args.package),
            "cases_sha256": hashlib.sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest(),
            "fixtures": helpers.inventory(FIXTURES),
            "harness_sha256": helpers.digest(__file__), "helpers_sha256": helpers.digest(helpers.__file__),
            "cli_metrics_sha256": helpers.digest(helpers.outcome_audit.__file__),
            "hosts": {h: {"version": helpers.run([h, "--version"], REPO).stdout.strip(),
                          "model": getattr(args, h + "_model"), "effort": "high"} for h in hosts},
            "node": helpers.run(["node", "--version"], REPO).stdout.strip(),
            "python": helpers.run(["python3", "--version"], REPO).stdout.strip(),
            "seed": args.seed, "repeats": args.repeats, "jobs": args.jobs, "timeout": args.timeout,
            "method": "isolated source; hidden behavioral acceptance; rotated arm order; shuffled tasks; host-model settings explicit; task time includes supplied briefing and agent calls, excludes install and acceptance; no population benefit claim"}
    metadata = args.output_dir / "metadata.json"
    if metadata.exists() and json.loads(metadata.read_text()) != meta:
        p.error("Resume inputs differ; use a new output directory")
    atomic_json(metadata, meta)
    rows = []
    with tempfile.TemporaryDirectory(prefix="crimes-outcome-tools-") as temp:
        cache = Path(temp)
        (cache / "package.json").write_text('{"private":true}')
        helpers.run(["npm", "install", "--no-audit", "--no-fund", "--silent", args.package], cache, timeout=180)
        tools = cache / "tools"
        tools.mkdir()
        for name in ["node", "npm", "git", "rg", "python3"]:
            found = shutil.which(name)
            if found:
                (tools / name).symlink_to(Path(found).resolve())
        work = schedule(cases, hosts, args.repeats, args.seed)
        print(f"Running {len(work)} trials with {args.jobs} workers", flush=True)
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            pending = {pool.submit(trial, *item, args, cache / "node_modules", tools): item for item in work}
            for future in as_completed(pending):
                try:
                    row = future.result()
                except Exception:
                    for waiting in pending:
                        waiting.cancel()
                    raise  # Stop queued work; completed trial files remain resumable.
                rows.append(row)
                atomic_json(args.output_dir / "results.json", {"metadata": meta, "rows": sorted(rows, key=lambda r:r["id"]), "summary": summary(rows)})
                print(f"{len(rows)}/{len(work)} {row['id']}: acceptance={row['acceptance_passed']} host={row['run_success']} scope-review={len(row['outside_expected_scope'])}", flush=True)
    print(json.dumps(summary(rows), indent=2))


if __name__ == "__main__":
    main()
