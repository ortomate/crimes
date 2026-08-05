import { compareMinor, minorKey } from "../suppressions-version.js";

/**
 * Per-detector release-notes map used by `crimes feedback recheck`.
 * Keyed by (detector_id, minor) — when a suppression resurfaces for
 * re-confirmation, we look up "what changed for this detector between
 * the pin and now?" so the user can decide whether to push the pin
 * forward (`fp`) or mark the finding resolved (`tp`).
 *
 * Entries are added as we ship detector behavioural changes. Falls
 * back to a generic message when nothing changed across the span.
 */
export const RELEASE_NOTES: Record<string, Record<string, string>> = {
  direct_date: {
    "0.21":
      "Clock readings are now classified as deciding a branch vs being recorded or rendered. Evidence names which lines do which, and a file whose readings are all values caps at medium severity however many there are. Your pin's finding still exists; its severity may have dropped.",
    "0.7":
      "direct_date now skips test files. Likely resolved if your fp was on a test file.",
  },
  large_function: {
    "0.6":
      "cli_command_registrar shape added — Commander DSL chains get a 200-line budget. Likely resolved for register*Command findings.",
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for anonymous callbacks that share a synthesized symbol within one file (schema_version 0.4.0). Re-record the pin against the callback you meant. Pins on named functions are unaffected.",
  },
  todo_density: {
    "0.6":
      "Detector now skips its own source file. Likely resolved if your file defines the TODO-density regex.",
  },
  large_file: {
    "0.6":
      "test_file shape added — test suites get a 1500-line budget. Likely resolved for *.test.ts / __tests__/ findings.",
    "0.17":
      "docs shape added — .md/.mdx/.rst/.adoc/.txt get a 1000-line budget at low/medium severity. Likely resolved for prose findings.",
  },
  magic_domain_literal_scatter: {
    "0.17":
      "Fingerprints now carry the literal as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several literals — re-record it against the one you meant.",
  },
  exact_duplicate_block: {
    "0.17":
      "Fingerprints now carry the duplicate group's body hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several groups — re-record it against the one you meant. Evidence strings are also reproducible run-to-run now.",
  },
  near_duplicate_block: {
    "0.17":
      "Fingerprints now carry the shape group's body hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that could cover several groups — re-record it against the one you meant.",
  },
  weak_test_signal: {
    "0.17":
      "Fingerprints now carry the test's title as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every test in the file — re-record it against the test you meant.",
    "0.18":
      "Python: nested test_* functions are no longer counted as tests, pytest.warns and @pytest.mark.xfail are credited as assertions, and a repo-wide symbol index resolves assertion helpers in other modules through the MRO. Likely resolved — airflow's claimed-silent tests fell 27.1%. Known limitation: two tests with identical titles in one file still share a fingerprint.",
  },
  commented_out_code: {
    "0.17":
      "Fingerprints now carry a hash of the comment block as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every block in the file — re-record it against the block you meant.",
    "0.18":
      "Matching now requires code syntax rather than bare code-ish words, so prose no longer fires. Likely resolved if your pin was on a licence header or a doc comment — airflow went 8,019 findings to 45.",
  },
  parallel_destination: {
    "0.18":
      'Now ships gated off by default (the first detector to do so) — it produced 2,819 findings from 134 files on n8n\'s editor-ui. Your pin is inert unless you opt in with "detectors": { "enable": ["parallel_destination"] }.',
  },
  pass_through_abstraction: {
    "0.18":
      "Chains are no longer built from shared method names: a member call is not followed at all, and a cross-file step requires the target to be exported. Likely resolved — n8n went from 7 chains at confidence ≥0.9 to 0.",
  },
  cross_language_route_drift: {
    "0.18":
      "An orphaned frontend route is only reported when the backend declares at least one route sharing its first path segment, so a sidecar service is no longer compared against the whole frontend. Likely resolved if your pin was on a HIGH finding naming an unrelated backend.",
  },
  boolean_naming_drift: {
    "0.18":
      "Python: scoped to unannotated locals inside a function. Class attributes, instance attributes and annotated bindings are excluded, so published API (Serializer(many=True), strip_whitespace) no longer fires. Likely resolved — drf went 7 to 1, pydantic 34 to 20.",
  },
  sync_io_in_hotpath: {
    "0.18":
      'Python: one finding per enclosing function rather than per module, so symbol, lines and evidence describe the same code (airflow span median 8 to 1 line). Django management commands and @cache-decorated functions are exempt. Re-record the pin against the function you meant. Known limitation: `if __name__ == "__main__"` scripts still classify as domain code.',
  },
  agent_permission_sprawl: {
    "0.18":
      "Repo-level findings now render in their own section of the human report rather than being buried under per-file groups. The finding itself is unchanged — only its visibility.",
  },
  dependency_provenance_gap: {
    "0.18":
      "tsconfig path aliases are collected from every tsconfig under apps/ / packages/ / libs/ / services/, not just a root one, and the `.`/`..` relative-path guard is fixed. Likely resolved if your pin was on an aliased specifier in a monorepo.",
  },
  logic_in_comments: {
    "0.21":
      'Domain terms are matched as whole words with a closed set of inflections, not as substrings — `auth` no longer matches "Authored" and `utc` no longer matches "outcome". The nearby-code check got the same treatment in the looser direction, so `cached` now counts as the code encoding `cache`. Likely resolved if your pin was on a comment that merely contained the letters of a domain term; a few findings a spurious nearby match had been suppressing now surface for the first time.',
    "0.17":
      "Fingerprints now carry a hash of the comment block as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every rule comment in the file — re-record it against the one you meant.",
  },
  swallowed_error: {
    "0.17":
      "Fingerprints now carry the protected operation as a discriminator, for handlers whose enclosing function and protected callee are shared (schema_version 0.4.0). Re-record the pin against the handler you meant. Pins on handlers that were already uniquely named are unaffected.",
  },
  unbounded_async_fanout: {
    "0.17":
      "Fingerprints now carry the collection expression as a discriminator, for fan-outs whose enclosing function and per-element call are shared (schema_version 0.4.0). Re-record the pin against the fan-out you meant. Pins on fan-outs that were already uniquely named are unaffected.",
  },
  name_behavior_mismatch: {
    "0.21":
      "A `create*`/`make*`/`init*` call whose result is bound and then dereferenced is treated as building the thing the function reads through, not as a side effect — `const supabase = await createClient(); supabase.from(…)` no longer charges a `get*` function. Likely resolved for data-access layers. Calls made for their effect, and `fetch`, still report.",
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for functions that share a name within one file (schema_version 0.4.0). Re-record the pin against the function you meant. Pins on uniquely-named functions are unaffected.",
  },
  return_shape_roulette: {
    "0.17":
      "Fingerprints now carry the start line as a discriminator, for anonymous functions that share the `<anonymous>` symbol within one file (schema_version 0.4.0). Re-record the pin against the function you meant. Pins on named functions are unaffected.",
  },
  negative_flag_maze: {
    "0.17":
      "Fingerprints now carry a hash of the conditional as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every conditional in the file — re-record it against the one you meant.",
  },
  duplicated_role_status_plan_check: {
    "0.17":
      "Fingerprints now carry the field and literal as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every policy literal anchored on that file — re-record it against the one you meant.",
  },
  duplicate_component_shape: {
    "0.17":
      "Fingerprints now carry the structural shape hash as a discriminator (schema_version 0.4.0). Your pin names an old fingerprint that covered every shape group anchored on that file — re-record it against the group you meant.",
  },
  high_fan_in_fan_out: {
    "0.21":
      "Fan-in is no longer promoted to medium when ≥80% of importers use `import type`. A shared type module's coupling is compile-time — change an interface and every importer fails to build. The count and the finding are unchanged; only the severity moves, and the evidence now says how many importers take types only.",
  },
  contract_drift: {
    "0.17":
      "Fingerprints now carry the other declaration as a discriminator, where one declaration drifts against several (schema_version 0.4.0). Re-record the pin against the pair you meant. Pins on single-pair findings are unaffected.",
  },
};

export const RELEASE_NOTES_FALLBACK =
  "detector behaviour unchanged. Re-confirm or mark resolved." as const;

/**
 * Look up the release-notes hints a user crossed when upgrading.
 *
 * With `pinnedMinor`, returns every note in `(pinnedMinor, targetMinor]`
 * joined oldest-first. Without it, returns the note for `targetMinor`
 * alone.
 *
 * The span, not the single minor, is the honest unit. This lookup keyed
 * on the target minor *exactly* until 0.19.0, so every note went
 * unreachable the moment the next minor shipped — 0.18.0 silently
 * orphaned all fifteen 0.17 notes, and 0.18.0–0.18.4 were never
 * published, so a real user upgrading 0.17 → 0.19 crosses two minors of
 * changes at once. Under the old lookup they were told "detector
 * behaviour unchanged" about the fingerprint change that invalidated
 * their pin. A check that returns the fallback for a perfectly valid
 * input is failing closed on correct input.
 */
export function releaseNoteFor(
  detectorId: string,
  targetMinor: string,
  pinnedMinor?: string,
): string {
  const notes = RELEASE_NOTES[detectorId];
  if (!notes) return RELEASE_NOTES_FALLBACK;
  if (pinnedMinor === undefined) {
    return notes[minorKey(targetMinor)] ?? RELEASE_NOTES_FALLBACK;
  }
  const crossed = Object.keys(notes)
    .filter(
      (minor) =>
        compareMinor(minor, pinnedMinor) > 0 && compareMinor(minor, targetMinor) <= 0,
    )
    .sort(compareMinor);
  if (crossed.length === 0) return RELEASE_NOTES_FALLBACK;
  return crossed.map((minor) => `${minor}: ${notes[minor]}`).join(" ");
}
