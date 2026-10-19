import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface AgentWorkspace {
  /** Disposable directory the agent runs in. Never inside this repo. */
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Give one agent invocation its own throwaway copy of the fixture.
 *
 * Before this existed the runner passed no `cwd`, so `claude -p` and
 * `codex exec` inherited the runner's own — inside the crimes working
 * tree. Round protocol rule 3 forbids exactly that, and the 0.29.1 round
 * showed the cost: `evals/fixtures/15-risky-service` is a symlink to
 * `examples/risky-service`, a scenario asked for a `deletedAt` field on a
 * fixture schema, and codex edited the real file and committed it. Twice,
 * on separate runs, reproducibly. Claude given the same prompt declined to
 * edit anything — so this cannot be left to agent judgement.
 *
 * Three properties matter, and each is a test:
 *
 * - **Dereferenced.** A symlinked fixture is copied as real files. A
 *   copy that preserved the link would let a write travel straight back
 *   into the repo, which is the bug itself.
 * - **Disposable.** One workspace per invocation, removed after. Two
 *   scenarios sharing a directory means the first one's edits are the
 *   second one's input.
 * - **No `.git`.** An agent that finds a repository can commit to it, and
 *   one did. The copy carries source, not history.
 *
 * `node_modules` is skipped too: fixtures are read, not built, and
 * copying an installed tree per invocation would dominate the run.
 */
export async function createAgentWorkspace(fixtureDir: string): Promise<AgentWorkspace> {
  const source = resolve(fixtureDir);
  const dir = await mkdtemp(join(tmpdir(), "crimes-eval-agent-"));
  await cp(source, dir, {
    recursive: true,
    // Follow the fixture symlink and any inside it: the agent must not
    // hold a reference to anything outside its own workspace.
    dereference: true,
    filter: (src) => {
      const name = basename(src);
      return name !== ".git" && name !== "node_modules";
    },
  });
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
