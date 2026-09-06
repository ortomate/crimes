"""Private helpers for the behavioral outcomes runner; no agent invocations on import."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

EXCLUDED = {".git", "node_modules", "__pycache__", ".pytest_cache"}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inventory(root):
    files = {}
    for base, directories, names in os.walk(root):
        directories[:] = sorted(d for d in directories if d not in EXCLUDED)
        for name in sorted(names):
            path = Path(base) / name
            if path.is_symlink():
                files[str(path.relative_to(root))] = "symlink:" + os.readlink(path)
            else:
                files[str(path.relative_to(root))] = digest(path)
    return files


def run(command, root, timeout=60, env=None):
    return subprocess.run([str(v) for v in command], cwd=root, input="", text=True,
                          capture_output=True, timeout=timeout, env=env, check=True)


def acceptance(case, root, fixtures):
    name = "acceptance.py" if case["language"] == "py" else "acceptance.mjs"
    path = root / (".outcome-" + name)
    shutil.copyfile(fixtures / case["id"] / name, path)
    try:
        command = ["python3" if case["language"] == "py" else "node", path.name]
        result = subprocess.run(command, cwd=root, input="", text=True, capture_output=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=30)
        return {"passed": result.returncode == 0, "exit_code": result.returncode,
                "output": (result.stdout + result.stderr).replace(str(root), "<workspace>")[-8000:]}
    except subprocess.TimeoutExpired:
        return {"passed": False, "exit_code": None, "output": "Acceptance timed out"}
    finally:
        path.unlink(missing_ok=True)


def install_wrapper(root, installed, log):
    modules = root / "node_modules"
    modules.mkdir()
    for package in installed.iterdir():
        if not package.name.startswith("."):
            (modules / package.name).symlink_to(package, target_is_directory=True)
    binary = modules / ".bin/crimes"
    binary.parent.mkdir()
    binary.write_text('''#!/usr/bin/env node
const {appendFileSync,readFileSync,readdirSync,readlinkSync,statSync} = require("node:fs");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const ROOT=__ROOT__, CLI=__CLI__, LOG=__LOG__, EXCLUDED=new Set(__EXCLUDED__);
const inventory=[];
function walk(base="") { for(const entry of readdirSync(ROOT+"/"+base,{withFileTypes:true})) {
  const relative=base+entry.name, path=ROOT+"/"+relative;
  if(entry.isDirectory()) { if(!EXCLUDED.has(entry.name)) walk(relative+"/"); }
  else if(entry.isSymbolicLink()) { let directory=false;try{directory=statSync(path).isDirectory();}catch{} if(!directory) inventory.push([relative,"symlink:"+readlinkSync(path)]); }
  else inventory.push([relative,createHash("sha256").update(readFileSync(path)).digest("hex")]);
}}
walk();inventory.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
const hash=createHash("sha256");for(const [path,value] of inventory){hash.update(path+"\\0"+value+"\\0");}
const args=process.argv.slice(2), source=hash.digest("hex"), started=Date.now();
const input=args[0]==="hook"?readFileSync(0,"utf8"):undefined;
const result=spawnSync(process.execPath,[CLI,...args],{input,encoding:"utf8",maxBuffer:32*1024*1024});
let report;try { const value=JSON.parse(result.stdout);report={type:value.report_type,root:value.repo?.root,file:value.file,status:value.analysis_status,fingerprints:value.findings?.map(f=>f.fingerprint),hook_context:!!value.hookSpecificOutput?.additionalContext};} catch {}
appendFileSync(LOG,JSON.stringify({args,cwd:process.cwd(),source,elapsed_ms:Date.now()-started,exit_code:result.status,report})+"\\n");
process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");process.exitCode=result.status??2;
'''.replace("__EXCLUDED__", json.dumps(sorted(EXCLUDED))).replace("__ROOT__", json.dumps(str(root)))
                      .replace("__CLI__", json.dumps(str(installed / "crimes/dist/index.js")))
                      .replace("__LOG__", json.dumps(str(log))))
    binary.chmod(0o755)
    return binary


def host_command(host, model, prompt, root):
    binary = shutil.which(host)
    if not binary:
        raise RuntimeError(f"Missing host: {host}")
    if host == "codex":
        return [binary, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--sandbox", "workspace-write", "--model", model,
                "-c", 'model_reasoning_effort="high"', "--cd", str(root), "--json", prompt]
    return [binary, "-p", "--verbose", "--output-format", "stream-json", "--model", model,
            "--effort", "high", "--setting-sources", "project,local", "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "acceptEdits",
            "--tools", "Read,Edit,Write,Bash,Glob,Grep,Skill",
            "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep,Skill", "--", prompt]


def invoke(command, root, tools, output, timeout):
    env = {**os.environ, "PATH": f"{tools}:/usr/bin:/bin:/usr/sbin:/sbin",
           "CI": "true", "PYTHONDONTWRITEBYTECODE": "1", "CRIMES_NOW": "2026-09-07T00:00:00Z"}
    started = time.monotonic()
    with (output / "host.jsonl").open("w") as stdout, (output / "stderr.log").open("w") as stderr:
        process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                   stdout=stdout, stderr=stderr, start_new_session=True)
        timed_out = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
    return {"exit_code": code, "timed_out": timed_out, "agent_elapsed_ms": round((time.monotonic()-started)*1000)}


def transcript_metrics(path, host):
    records = []
    for line in path.read_text().splitlines():
        try:
            records.append(json.loads(line))
        except ValueError:
            pass
    commands, usage, models = [], {}, set()
    final_seen = False
    for record in records:
        if host == "codex":
            item = record.get("item", {})
            if record.get("type") == "item.completed" and item.get("type") == "command_execution" and item.get("exit_code") == 0:
                commands.append(item.get("command", ""))
            if record.get("type") == "turn.completed":
                final_seen = True
                for key, value in record.get("usage", {}).items():
                    if isinstance(value, (int, float)):
                        usage[key] = usage.get(key, 0) + value
        else:
            message = record.get("message", {})
            if message.get("model"):
                models.add(message["model"])
            for block in message.get("content", []) if isinstance(message.get("content"), list) else []:
                if block.get("type") == "tool_use":
                    commands.append(json.dumps({"tool": block.get("name"), "input": block.get("input")}))
            if record.get("type") == "result":
                final_seen = not record.get("is_error", False)
                usage = record.get("usage", {})
    # Only observed tool actions count, not prose or system metadata mentioning a skill.
    loaded = any(("skills/crimes/SKILL.md" in command and re.search(r'\b(cat|sed|Read|head|Skill)\b', command)) or
                 ('"tool": "Skill"' in command and re.search(r'"skill":\s*"crimes', command))
                 for command in commands)
    return {"skill_action_observed": loaded, "usage_reported": usage,
            "observed_models": sorted(models), "successful_completion_event": final_seen}


def source_digest(root):
    hashed = hashlib.sha256()
    for path, value in sorted(inventory(root).items()):
        hashed.update((path + "\0" + value + "\0").encode())
    return hashed.hexdigest()


def cli_metrics(path, original_source, final_source):
    calls = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    scans = [c for c in calls if c["args"] and c["args"][0] == "scan" and c["exit_code"] == 0]
    comparable = any(a["args"] == b["args"] and a["cwd"] == b["cwd"] and
                     a["source"] == original_source and b["source"] == final_source and original_source != final_source and
                     (a.get("report") or {}).get("type") == "scan" and (b.get("report") or {}).get("type") == "scan"
                     for i, a in enumerate(scans) for b in scans[i+1:])
    return {"cli_calls": len(calls), "cli_elapsed_ms": sum(c["elapsed_ms"] for c in calls),
            "context_calls": sum(c["args"][0] == "context" for c in calls),
            "hook_contexts": sum(bool((c.get("report") or {}).get("hook_context")) for c in calls),
            "comparable_pre_post_scans": comparable}
