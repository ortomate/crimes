"""Exercise actual TTY detection against the packed CLI (macOS/Linux)."""
import argparse
import os
import pty
import select
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--cli", required=True)
parser.add_argument("--project", required=True)
parser.add_argument("--json", action="store_true")
args = parser.parse_args()
master, slave = pty.openpty()
env = dict(os.environ)
env.pop("CI", None)
env["NO_COLOR"] = "1"
command = [args.cli, "scan"] + (["--format", "json"] if args.json else [])
child = subprocess.Popen(command, cwd=args.project, env=env, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.2)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
        elif child.poll() is not None:
            break
    if child.poll() is None:
        child.wait(timeout=max(0.1, deadline - time.monotonic()))
    assert child.returncode == 0, output.decode(errors="replace")
    text = output.decode(errors="replace")
    assert "Generate one" not in text, text
    if args.json:
        assert "refreshed agent skills" not in text, text
        assert '"report_type": "scan"' in text, text
    else:
        assert "refreshed agent skills" in text, text
    print("  → real TTY JSON stayed read-only" if args.json else "  → real TTY scan refreshed generated skills")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
