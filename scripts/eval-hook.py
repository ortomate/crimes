#!/usr/bin/env python3
"""Opt-in actual Claude test of the installed generated hook's context delivery.

Uses an isolated synthetic project, no installed skill, and an unpredictable
handoff token appended only to the real hook output. Raw traces stay outside
scanned sources. Requires an authenticated Claude CLI.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location("skill_eval", Path(__file__).with_name("eval-skills.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", required=True)
parser.add_argument("--output-dir", type=Path, required=True)
args = parser.parse_args()
output = args.output_dir.resolve()
output.mkdir(parents=True, exist_ok=True)
package = str(Path(args.package).resolve()) if Path(args.package).exists() else args.package
with tempfile.TemporaryDirectory(prefix="crimes-hook-host-") as temp:
    root = Path(temp)
    cli_log = output / "cli.jsonl"
    version = helpers.prepare(root, package, "claude", cli_log)
    binary = root / "node_modules/.bin/crimes"
    helpers.run([binary, "init", "--agent-skill"], root)
    shutil.rmtree(root / ".claude/skills")
    source = root / "src/shipping.js"
    legacy = '\nexport function legacyShippingReport() {\n' + ''.join(
        f'  const zone{i} = {i};\n' for i in range(230)
    ) + '  return zone0;\n}\n'
    source.write_text(source.read_text() + legacy)
    helpers.run(["git", "add", "."], root)
    helpers.run(["git", "-c", "user.name=Hook test", "-c", "user.email=hooks@example.invalid", "commit", "-qm", "hook fixture"], root)
    token = "hook-receipt-" + secrets.token_hex(12)
    hook_log = output / "hook.jsonl"
    bundle = root / "node_modules/crimes/dist/index.js"
    binary.write_text('''#!/usr/bin/env node
import {appendFileSync,readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const input=readFileSync(0,"utf8");
const result=spawnSync(process.execPath,[BUNDLE,...process.argv.slice(2)],{input,encoding:"utf8"});
let output=result.stdout;
if(process.argv[2]==="hook") {
  const report=JSON.parse(output);
  const record={args:process.argv.slice(2),input:JSON.parse(input),report,
    sourceHash:createHash("sha256").update(readFileSync(SOURCE)).digest("hex")};
  appendFileSync(LOG,JSON.stringify(record)+"\\n");
  report.hookSpecificOutput.additionalContext += "\\nHandoff token: " + TOKEN;
  output=JSON.stringify(report)+"\\n";
}
process.stdout.write(output);
process.stderr.write(result.stderr);
process.exit(result.status ?? 2);
'''.replace("BUNDLE", json.dumps(str(bundle))).replace("SOURCE", json.dumps(str(source))).replace("LOG", json.dumps(str(hook_log))).replace("TOKEN", json.dumps(token)))
    binary.chmod(0o755)
    before = helpers.digest(source)
    settings_before = helpers.digest(root / ".claude/settings.local.json")
    prompt = (
        "Change the express shipping fee in src/shipping.js from 9 to 12; standard must stay 5 "
        "and unknown methods must still throw. Update its test. Use the Edit tool for edits. "
        "Preserve unrelated code, including legacyShippingReport. Run the behavior tests. "
        "If a pre-edit hook supplies a handoff token, include that token and its reported risk "
        "in your final response. Work only in this project; do not download tools, change "
        "configuration or packages, access network tools, or commit."
    )
    command, host_version = helpers.host_command("claude", prompt, root)
    started = time.monotonic()
    env = {**os.environ, "CI": "true", "CLAUDE_PROJECT_DIR": str(root)}
    with (output / "host.jsonl").open("w") as stdout, (output / "stderr.log").open("w") as stderr:
        result = subprocess.run([str(x) for x in command], cwd=root, env=env, stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr, text=True, timeout=300)
    assert result.returncode == 0, "Claude failed; inspect raw traces"
    transcript = (output / "host.jsonl").read_text()
    messages = [json.loads(line) for line in transcript.splitlines() if line.startswith("{")]
    final = next((message.get("result", "") for message in reversed(messages) if message.get("type") == "result"), "")
    assert token in final, "The host did not acknowledge the private hook token"
    records = [json.loads(line) for line in hook_log.read_text().splitlines()]
    pre = [record for record in records if record["sourceHash"] == before]
    assert pre, "No hook ran before the implementation edit"
    assert any("God Function" in record["report"]["hookSpecificOutput"]["additionalContext"] for record in pre)
    assert all("permissionDecision" not in record["report"]["hookSpecificOutput"] for record in records)
    assert source.read_text().endswith(legacy), "Unrelated legacy code changed"
    assert helpers.digest(root / ".claude/settings.local.json") == settings_before
    helpers.run(["node", "--input-type=module", "-e", 'import assert from "node:assert/strict";import{shippingFee}from"./src/shipping.js";assert.equal(shippingFee("express"),12);assert.equal(shippingFee("standard"),5);assert.throws(()=>shippingFee("unknown"));'], root)
    helpers.run(["npm", "test"], root)
    changed = helpers.run(["git", "diff", "--name-only"], root).stdout.splitlines()
    untracked = helpers.run(["git", "ls-files", "--others", "--exclude-standard"], root).stdout.splitlines()
    assert set(changed + untracked) <= {"src/shipping.js", "src/shipping.test.js"}, changed + untracked
    summary = {"host": "claude", "host_version": host_version, "crimes_version": version,
               "model_selection": "host default", "skill_installed": False,
               "generated_hook_executed": True, "pre_edit_risk_delivered": True,
               "private_token_acknowledged": True, "permission_decision_returned": False,
               "acceptance_passed": True, "unrelated_edits": [], "hook_calls": len(records),
               "elapsed_seconds": round(time.monotonic() - started, 2),
               "limitations": "One synthetic Edit task; private token appended by the observer to verify host delivery. Not a productivity or calibration measurement."}
    (output / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
