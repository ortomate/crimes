# 0.28 release readiness review

The September product review asked for trustworthy pre-edit context, quieter
prioritization, recoverable decisions, useful agent integration and maintainable
human/agent documentation. The 0.28.2 follow-up rechecked those outcomes against
first use, upgrades and the published surfaces, after a user found that the
skill refresh mechanism had no discoverable update path.

## Review coverage

| Accepted outcome | Evidence and follow-up |
| --- | --- |
| Context agrees with scan | Shared analysis and existing context regression tests cover authority/agent configuration, claims, importing tests and excluded/partial targets. Hook delivery and root selection were missing from this check; 0.28.2 repairs both. |
| Default signal outranks repetitive noise | Bounded file ranking and conservative/default-off choices from 0.28 remain. Ranking uses the same corpus and clock; no detector or scoring changes are included in this patch. |
| Prior decisions survive upgrades | Pin migration preserves metadata and refuses stale plans/collisions. CI/suppression guides still encouraged blanket re-pinning; that advice is corrected. Migration's multi-file transaction limit remains explicit. |
| Skills work in installed hosts | 0.28.1 exercised fresh host discovery and actual scoped edits. This patch adds discoverable maintenance and real-terminal upgrade checks, and retains customizations. |
| Hooks deliver useful evidence | The old command printed plain PreToolUse output, used an incorrect timeout unit and could fetch independently through npm. This patch fixes the host envelope, root, evidence/status presentation and offline executable selection. |
| JSON is a usable public contract | A deeper check found stale declarations, hardcoded feedback versions and unversioned/prose triage output. Runtime envelopes are corrected and public type declarations are now generated and checked. |
| Humans and agents find consistent docs | Current workflow guides replace obsolete instructions. The built site had broken relative Markdown links; conversion and internal-link verification now cover the rendered result. |
| Improvements are measured honestly | Unit/integration checks, installed-package upgrades, host delivery and ranking answer separate questions. None is presented as proof of general agent productivity or defect reduction. |

## Remaining limits

- **Agent outcome benefit is unproven.** The 0.28 paired edit trial tied at
  3/3 acceptance passes per arm. Broader tasks, repetitions and controlled
  model selection are still needed. A successful host integration check
  does not fill that evidence gap.
- **Context latency remains material.** Context and the hook analyze the
  repository. The 0.28 self-repo observation rose from 3.52s to 8.99s;
  caching/shared parsed-input reuse was explicitly deferred. No performance
  improvement is claimed for 0.28.2. Hooks remain optional.
- **Heuristic analysis is incomplete evidence.** Import/test discovery is not
  executed coverage. Universal analysis does not imply a language parser
  covered every file. Ranking labels remain partly type-level and the deep
  set is dominated by one fixture.
- **Pins need judgment.** Absence does not prove resolution. Migration replaces
  each selected file atomically but is not a transaction across all pin files;
  retain a commit or backup before applying a reviewed plan.
- **Host behavior can vary.** A host can fail to activate a skill or omit its
  instructions. Changing a file on disk does not retroactively reload a skill
  already read in the current conversation. Restart/reload when needed.
- **Distribution scope remains npm.** Homebrew, standalone/Windows binaries,
  additional languages, `crimes ask`, hosted services and paid tiers remain
  deferred. Adoption and retention are not established by download counts.

These are explicit limits, not completed goals. The release is intended to be
shareable as a local evidence tool, with accurate instructions and working
integration paths. [0.28.2 release notes](./releases/v0.28.2.md) record validation.
