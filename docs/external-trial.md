# Try crimes on one real change

This trial asks whether crimes helps you make a particular change. Choose a
repository you are allowed to work on and an ordinary, already-planned edit.
Use a branch and your usual coding agent or editor. No account, telemetry or
upload is required by crimes; agent hosts retain their own data policies.

## Start from the published package

```bash
npm install --save-dev --save-exact crimes@0.28.2
./node_modules/.bin/crimes --version
./node_modules/.bin/crimes init --codex-skill
# Claude Code instead: ./node_modules/.bin/crimes init --agent-skill
```

These instructions pin 0.28.2 for reproducibility. A maintainer testing a
candidate can supply its tarball and record the version and artifact hash.
Review the generated configuration and skill. The Claude setup also installs
an optional per-edit hook; `--no-hooks` skips it. Restart/reload the host so
the new skill can be discovered. Installation details: [skills](./skills.md).

Before running crimes, write down the intended change, the files you expect
to touch, and the tests you would normally run. This prevents a useful-looking
report from becoming its own definition of success.

## Make the change

Ask the agent to perform the real task and review change risk. Do not give it
an artificial checklist that forces it to use crimes: we also need to know
whether normal skill discovery works. Keep its transcript locally if useful.

If working manually, run context with the intended repository root, retain a
pre-edit JSON scan outside the source tree, and compare the same scope after
editing. The [agent workflow](./agent-usage.md) gives exact commands. Run your
normal behavior tests independently; an empty crimes report is not a safety
verdict.

## Record what happened

Use this small record. An inconvenient or unhelpful result is useful evidence.

| Item | Your observation |
| --- | --- |
| Version, OS, Node, host/model | |
| Task and approximate repository size/languages | |
| Did the skill activate without naming it? | |
| Did a finding change what you read, edited or tested? Which one? | |
| Was that advice correct after inspecting the source? | |
| Did anything distract the agent or cause unnecessary edits? | |
| Did context/hook waiting interrupt the work? | |
| Did the completed edit pass independent tests and review? | |
| Would you keep crimes enabled for the next change? Why? | |

For a false positive, record the exact fingerprint and your reason with
`crimes feedback <fingerprint> --verdict fp --note "<reason>"`. This writes
feedback **and a suppression**; use it only after reviewing the finding.
Preserve existing decisions and expiry dates.

```bash
./node_modules/.bin/crimes feedback export --format json > /tmp/crimes-feedback.json
```

Review that file before choosing to share it: paths, symbols, reasons and
notes can reveal project information. A redacted written observation or a
small reproduction is sufficient. Sharing is voluntary; do not attach a full
private repository or transcript by default. Maintainers should retain
negative reports, the user's original rationale and the version tested.

One observed outcome does not establish a causal improvement. It can identify
a concrete reproduction, onboarding problem, or reason someone would keep
or disable the tool. No independently reported trial outcome has been
collected by this follow-up yet.
