#!/usr/bin/env python3
"""Opt-in host test: install a package, discover its skill, perform a scoped edit.

Requires authenticated Codex/Claude CLIs. Raw host logs stay in --output-dir;
only the synthetic fixture and instructions are supplied to the hosts.
Example: python3 scripts/eval-skills.py --package /tmp/crimes-0.28.1.tgz \
    --output-dir /tmp/crimes-skill-evidence
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def run(args, cwd, **kwargs):
    result = subprocess.run(
        [str(arg) for arg in args], cwd=cwd, text=True, capture_output=True,
        timeout=kwargs.pop("timeout", 180), stdin=subprocess.DEVNULL, **kwargs
    )
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}\n{result.stdout}\n{result.stderr}")
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(root, package, host, log):
    (root / "package.json").write_text(json.dumps({
        "name": "crimes-skill-behavior-fixture", "private": True, "type": "module",
        "scripts": {"test": "node --test src/shipping.test.js"},
    }))
    run(["npm", "install", "--no-audit", "--no-fund", "--silent", package], root)
    binary = root / "node_modules/.bin/crimes"
    host_flag = "--codex-skill" if host == "codex" else "--agent-skill"
    run([binary, "init", "--refresh-skills", host_flag], root)
    (root / "crimes.config.json").write_text('{"include":["src/**/*.js"]}\n')
    (root / "src").mkdir()
    (root / "src/shipping.js").write_text(
        'export function shippingFee(method) {\n'
        '  if (method === "standard") return 5;\n'
        '  if (method === "express") return 9;\n'
        '  throw new Error("Unknown shipping method");\n}\n'
    )
    (root / "src/shipping.test.js").write_text(
        'import test from "node:test";\nimport assert from "node:assert/strict";\n'
        'import { shippingFee } from "./shipping.js";\n'
        'test("shipping fees", () => {\n'
        '  assert.equal(shippingFee("standard"), 5);\n'
        '  assert.equal(shippingFee("express"), 9);\n'
        '  assert.throws(() => shippingFee("unknown"));\n});\n'
    )
    (root / ".gitignore").write_text("node_modules/\n")
    run(["git", "init", "-q"], root)
    run(["git", "add", "."], root)
    run(["git", "-c", "user.name=Skill test", "-c", "user.email=skills@example.invalid",
         "commit", "-qm", "fixture"], root)
    # Observe actual CLI calls without changing the real bundle or its output.
    binary.unlink()
    binary.write_text(
        '#!/usr/bin/env node\n'
        'import {appendFileSync,readFileSync} from "node:fs";\n'
        'import {createHash} from "node:crypto";\n'
        'import {spawnSync} from "node:child_process";\n'
        f'const source={json.dumps(str(root / "src/shipping.js"))};\n'
        'const record={args:process.argv.slice(2),cwd:process.cwd(),'
        'source: createHash("sha256").update(readFileSync(source)).digest("hex")};\n'
        f'appendFileSync({json.dumps(str(log))},JSON.stringify(record)+"\\n");\n'
        f'const result=spawnSync(process.execPath,[{json.dumps(str(root / "node_modules/crimes/dist/index.js"))},...process.argv.slice(2)],{{stdio:"inherit"}});\n'
        'process.exit(result.status ?? 2);\n'
    )
    binary.chmod(0o755)
    return json.loads((root / "node_modules/crimes/package.json").read_text())["version"]


def host_command(host, prompt, root):
    binary = shutil.which(host)
    if not binary:
        raise RuntimeError(f"{host} is not installed")
    version = run([binary, "--version"], root).stdout.strip()
    if host == "codex":
        args = [binary, "exec", "--ignore-user-config", "--ephemeral",
                "--sandbox", "workspace-write", "--cd", root, "--json", prompt]
    else:
        args = [binary, "-p", "--verbose", "--output-format", "stream-json",
                "--setting-sources", "project,local", "--strict-mcp-config",
                "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "acceptEdits",
                "--tools", "Read,Edit,Write,Bash,Glob,Grep,Skill",
                "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep,Skill", "--", prompt]
    return args, version


def evaluate(host, package, output, parent):
    root = parent / host
    root.mkdir()
    log = output / f"{host}-cli.jsonl"
    version = prepare(root, package, host, log)
    original = digest(root / "src/shipping.js")
    immutable = {path: digest(root / path) for path in [
        "package.json", "package-lock.json", "crimes.config.json",
        (".agents" if host == "codex" else ".claude") + "/skills/crimes/SKILL.md",
    ]}
    prompt = (
        "Change the express shipping fee from 9 to 12; standard must remain 5 and "
        "unknown methods must still throw. Update the relevant tests. Review change "
        "risk and verify the result. Keep the edit scoped to this request. "
        "Work only in this project; do not download tools, access the network, "
        "change package/config/skill files, or commit. "
        "Use temporary storage outside scanned source files for any working reports."
    )
    args, host_version = host_command(host, prompt, root)
    # The project CLI is deliberately not on PATH, exercising local invocation.
    tools = parent / f"{host}-tools"
    tools.mkdir()
    for command in ["node", "npm", "git", "rg", "python3"]:
        found = shutil.which(command)
        if found:
            (tools / command).symlink_to(Path(found).resolve())
    env = {**os.environ, "PATH": f"{tools}:/usr/bin:/bin:/usr/sbin:/sbin", "CI": "true"}
    started = time.monotonic()
    with (output / f"{host}-host.jsonl").open("w") as stdout, (output / f"{host}-stderr.log").open("w") as stderr:
        result = subprocess.run([str(arg) for arg in args], cwd=root, env=env,
                                text=True, stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr, timeout=600)
    transcript = (output / f"{host}-host.jsonl").read_text()
    assert result.returncode == 0, f"{host} failed; inspect host logs"
    current = digest(root / "src/shipping.js")
    assert current != original, "The host did not edit the implementation"
    run(["node", "--input-type=module", "-e",
         'import assert from "node:assert/strict";'
         'import {shippingFee} from "./src/shipping.js";'
         'assert.equal(shippingFee("express"),12);'
         'assert.equal(shippingFee("standard"),5);'
         'assert.throws(()=>shippingFee("unknown"));'], root)
    run(["npm", "test"], root)
    for path, before in immutable.items():
        assert digest(root / path) == before, f"Unrelated edit: {path}"
    assert log.exists(), "The host bypassed the instrumented project CLI; inspect version selection in its trace"
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    before = [c for c in calls if c["source"] == original]
    after = [c for c in calls if c["source"] == current]
    assert any("context" in c["args"] and "--root" in c["args"] for c in before), "Missing pre-edit context"
    pre_scans = [c for c in before if c["args"][0] == "scan"]
    post_scans = [c for c in after if c["args"][0] == "scan"]
    comparable = any(sorted(a["args"]) == sorted(b["args"]) and a["cwd"] == b["cwd"]
                     for a in pre_scans for b in post_scans)
    assert comparable, "Missing comparable pre/post scan"
    loaded = ("/skills/crimes/SKILL.md" in transcript or
              (re.search(r'"name"\s*:\s*"Skill"', transcript) and
               re.search(r'"(?:skill|command)"\s*:\s*"crimes[^"]*"', transcript)))
    assert loaded, "Skill read/invocation was not observed in the host trace"
    changed = run(["git", "diff", "--name-only"], root).stdout.splitlines()
    untracked = run(["git", "ls-files", "--others", "--exclude-standard"], root).stdout.splitlines()
    assert set(changed + untracked) <= {"src/shipping.js", "src/shipping.test.js"}, changed + untracked
    return {"host": host, "host_version": host_version, "crimes_version": version,
            "model_selection": "host default", "skill_loaded": True,
            "local_cli_used": True, "pre_edit_context": True,
            "comparable_pre_post_scans": True, "acceptance_passed": True,
            "unrelated_edits": [], "cli_calls": len(calls),
            "elapsed_seconds": round(time.monotonic() - started, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="Tarball path or explicit npm version")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--host", choices=["codex", "claude", "both"], default="both")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    package = str(Path(args.package).resolve()) if Path(args.package).exists() else args.package
    hosts = ["codex", "claude"] if args.host == "both" else [args.host]
    results = []
    with tempfile.TemporaryDirectory(prefix="crimes-skill-hosts-") as temp:
        for host in hosts:
            print(f"Testing {host} discovery and workflow...", flush=True)
            results.append(evaluate(host, package, args.output_dir.resolve(), Path(temp)))
            print(json.dumps(results[-1], indent=2), flush=True)
            (args.output_dir / "results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
