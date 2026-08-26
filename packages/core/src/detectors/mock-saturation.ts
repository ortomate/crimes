import { z } from "zod";
import { basename, dirname } from "node:path";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { AssertionCategory, MockDeclaration, TestCase } from "@crimes/language-js";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreRationale,
} from "../scoring/confidence.js";
import { isTestFile, testBaseCovers } from "../util/test-files.js";
import { classifyBoundary } from "../domain/vocabulary.js";

/**
 * Mock Alibi — a test that looks like coverage and proves very little.
 *
 * ## The shape being detected
 *
 * Every meaningful collaborator is replaced with a double that has no
 * behaviour, and every assertion is about those doubles. The test then
 * says: "when I call the function, it calls the thing I replaced with a
 * thing that does nothing, with the arguments I expected." That is a
 * restatement of the implementation, not a check on it. It passes before
 * and after a refactor that breaks production, and it fails whenever the
 * implementation is improved without changing behaviour — the exact
 * opposite of what a test should do.
 *
 * ## Why this is not "mocks are bad"
 *
 * Mocks are how you make a unit test fast and deterministic, and a
 * focused test that mocks a clock and asserts a returned value is
 * excellent. This detector requires a **combination** of signals before
 * it says anything:
 *
 *  - most or all imported production collaborators are replaced, **and**
 *  - the replacements are hollow (no implementation, no canned value),
 *    **and**
 *  - assertions are exclusively about mock interactions.
 *
 * Any one of those alone is normal. Together they mean the test cannot
 * observe behaviour, because there is no behaviour left to observe.
 *
 * ## Escalation
 *
 * Severity rises when the doubles stand in for consequential boundaries
 * — persistence, payment, authorization, queues — because those are the
 * places where "it called the right function" and "it did the right
 * thing" diverge most expensively.
 *
 * ## What it deliberately does not claim
 *
 * That the test is worthless or should be deleted. The remediation is
 * additive: keep the fast unit test, add one that exercises the real
 * contract.
 */

const optionsSchema = z
  .object({
    /**
     * Fraction of imported production collaborators that must be mocked
     * before saturation is considered. Default 0.8.
     */
    minMockedRatio: z.number().min(0.1).max(1).optional(),
    /** Distinct collaborators that must be mocked. Default 2. */
    minMockedCollaborators: z.number().int().min(1).max(50).optional(),
    /**
     * Report cases whose assertions are all mock-interaction even when
     * the mock ratio is below threshold. Default false — the ratio is
     * what separates a focused unit test from an alibi.
     */
    reportInteractionOnlyTests: z.boolean().optional(),
    /** Module specifiers whose mocking never counts toward saturation. */
    alwaysAllowedMocks: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS_PER_FILE = 5;

/**
 * Specifiers that are *infrastructure*, not the subject. Mocking a clock
 * or the filesystem is how you make a test deterministic; it is never
 * evidence that the test proves nothing.
 */
const INFRASTRUCTURE_MOCKS =
  /^(node:)?(fs|fs\/promises|path|os|crypto|child_process|http|https|net|timers|timers\/promises|util)$/;

export const mockSaturationDetector: LanguageJsDetector = {
  id: "mock_saturation",
  // "The subject never ran" and "the collaborators never ran" are
  // different failures with different fixes — unmock the subject, versus
  // assert an outcome instead of a call. Nothing but the summary prose
  // told them apart before.
  claims: ["subject_mocked", "collaborators_mocked"],
  name: "Mock Alibi",
  description:
    "Flags tests that replace most meaningful collaborators with " +
    "behaviourless doubles and then assert only on those doubles, so the " +
    "test reports coverage it does not provide.",
  whyItMatters:
    "A test that mocks everything and asserts on the mocks restates the " +
    "implementation instead of checking it. It passes through refactors " +
    "that break production and fails on refactors that do not, which is " +
    "backwards. The cost is highest for agents: a green suite is the main " +
    "signal an agent uses to decide a change is safe, and these tests " +
    "stay green no matter what the change did.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    if (!isTestFile(ctx.file)) return [];

    const cases = ctx.parsed.testCases ?? [];
    const mocks = ctx.parsed.mockDeclarations ?? [];
    if (cases.length === 0 || mocks.length === 0) return [];

    const options = readOptions(ctx.config);
    const minRatio = options.minMockedRatio ?? 0.8;
    const minCollaborators = options.minMockedCollaborators ?? 2;
    const allowed = new Set(
      (options.alwaysAllowedMocks ?? []).map((m) => m.toLowerCase()),
    );

    const imports = productionImports(ctx.source);
    const subject = inferSubject(ctx.file, imports);
    const meaningful = meaningfulMocks(mocks, allowed);
    if (meaningful.length < minCollaborators) return [];

    const mockedRatio = collaboratorMockRatio(imports, meaningful, subject);
    const hollow = meaningful.filter((m) => m.hollow);
    const boundaries = boundariesCovered(meaningful);
    const subjectMocked = subject !== undefined && mocksSubject(meaningful, subject);

    const findings: Finding[] = [];
    for (const testCase of cases) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;

      const verdict = assess(testCase, {
        mockedRatio,
        minRatio,
        hollowCount: hollow.length,
        meaningfulCount: meaningful.length,
        reportInteractionOnly: options.reportInteractionOnlyTests === true,
      });
      if (!verdict.report) continue;

      findings.push(
        buildFinding({
          file: ctx.file,
          testCase,
          subject,
          meaningful,
          hollow,
          mockedRatio,
          imports,
          boundaries,
          subjectMocked,
          verdict,
        }),
      );
    }

    return findings;
  },
};

/* ------------------------------------------------------------------ *
 * Assessment
 * ------------------------------------------------------------------ */

interface Verdict {
  report: boolean;
  /** Assertion categories observed, sorted. */
  categories: AssertionCategory[];
  /** Assertions that observe behaviour rather than interactions. */
  behavioural: number;
  /** Assertions that only observe a double. */
  interaction: number;
  /** Short reason the case was reported. */
  reason: string;
}

function assess(
  testCase: TestCase,
  ctx: {
    mockedRatio: number;
    minRatio: number;
    hollowCount: number;
    meaningfulCount: number;
    reportInteractionOnly: boolean;
  },
): Verdict {
  const categories = [...new Set(testCase.assertions.map((a) => a.category))].sort();
  const interaction = testCase.assertions.filter(
    (a) => a.category === "mock_interaction",
  ).length;
  const behavioural = testCase.assertions.filter((a) =>
    BEHAVIOURAL_CATEGORIES.has(a.category),
  ).length;

  const base: Omit<Verdict, "report" | "reason"> = {
    categories,
    behavioural,
    interaction,
  };

  // A case with no assertions at all is `weak_test_signal`'s crime, not
  // this one. Emitting both would be two findings for one problem.
  if (testCase.assertions.length === 0) {
    return { ...base, report: false, reason: "" };
  }
  // Any assertion about a real value, state change, or thrown error means
  // the test observed something. That is the whole defence.
  if (behavioural > 0) {
    return { ...base, report: false, reason: "" };
  }
  if (interaction === 0) {
    return { ...base, report: false, reason: "" };
  }

  const saturated = ctx.mockedRatio >= ctx.minRatio && ctx.hollowCount >= 1;
  if (!saturated && !ctx.reportInteractionOnly) {
    return { ...base, report: false, reason: "" };
  }

  return {
    ...base,
    report: true,
    reason: saturated
      ? `${Math.round(ctx.mockedRatio * 100)}% of imported collaborators are mocked and every assertion observes a mock`
      : "every assertion observes a mock rather than an outcome",
  };
}

/**
 * Categories that mean the test looked at something the subject actually
 * produced. `truthiness` is deliberately excluded — `expect(x).toBeDefined()`
 * after a mocked call proves the mock returned, not that the code worked.
 * `snapshot` is excluded because a snapshot of mock output is a snapshot
 * of the mock.
 */
const BEHAVIOURAL_CATEGORIES: ReadonlySet<AssertionCategory> = new Set([
  "value",
  "error",
]);

/* ------------------------------------------------------------------ *
 * Finding
 * ------------------------------------------------------------------ */

function buildFinding(args: {
  file: string;
  testCase: TestCase;
  subject?: string;
  meaningful: MockDeclaration[];
  hollow: MockDeclaration[];
  mockedRatio: number;
  imports: string[];
  boundaries: string[];
  subjectMocked: boolean;
  verdict: Verdict;
}): Finding {
  const { testCase, verdict } = args;
  const title = [...testCase.suite, testCase.title].join(" › ");

  const confidence = new ConfidenceLadder(0.6)
    .add(
      args.mockedRatio >= 0.9,
      `${Math.round(args.mockedRatio * 100)}% of collaborators mocked`,
      0.12,
    )
    .add(
      args.hollow.length >= 2,
      `${args.hollow.length} doubles have no implementation`,
      0.1,
    )
    .add(
      verdict.interaction >= 2,
      `${verdict.interaction} mock-interaction assertions, 0 behavioural`,
      0.08,
    )
    .add(args.subjectMocked, "the subject under test appears to be mocked", 0.1)
    .add(
      testCase.mockConfigurations >= 3,
      `${testCase.mockConfigurations} calls program the doubles`,
      0.05,
    )
    .add(args.subject === undefined, "subject under test could not be identified", -0.1);

  const severity = new SeverityLadder(0.35)
    .add(
      args.boundaries.length > 0,
      `mocks stand in for ${args.boundaries.join(", ")}`,
      0.18,
    )
    .add(args.subjectMocked, "the subject itself is mocked", 0.2)
    .add(args.boundaries.length >= 2, "multiple consequential boundaries mocked", 0.08)
    .add(args.hollow.length >= 3, "three or more behaviourless doubles", 0.06);

  const built = buildEvidence(args, confidence, severity);
  return {
    id: "",
    type: "mock_saturation",
    charge: "Mock Alibi",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: args.file,
    lines: [testCase.line, testCase.endLine],
    symbol: title,
    claim: args.subjectMocked ? "subject_mocked" : "collaborators_mocked",
    summary: args.subjectMocked
      ? `Test "${title}" appears to mock the subject under test itself, so it ` +
        "cannot observe the behaviour it is named for."
      : `Test "${title}" replaces ${args.meaningful.length} collaborator(s) with ` +
        "behaviourless doubles and asserts only on those doubles. It reports " +
        "coverage of a code path it never really exercises.",
    evidence: built.evidence,
    score_rationale: built.rationale,
    effort: "medium",
    fix_shape: "add one test that asserts an outcome, not a call",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "assert_observable_outcome",
        description:
          "Keep this test, and add an assertion on something the subject " +
          "produces — a returned value, a thrown error, or a state change — " +
          "so a behaviour regression can fail it.",
        risk: "low",
      },
      {
        kind: "add_boundary_test",
        description:
          args.boundaries.length > 0
            ? `Add one integration or contract test that exercises the ` +
              `${args.boundaries[0]} boundary for real (an in-memory or ` +
              "containerised substitute is enough), so the interaction is " +
              "verified somewhere."
            : "Add one test that runs the subject against real collaborators, " +
              "so the wiring between them is verified somewhere.",
        risk: "medium",
      },
    ],
  };
}

function buildEvidence(
  args: {
    testCase: TestCase;
    subject?: string;
    meaningful: MockDeclaration[];
    hollow: MockDeclaration[];
    mockedRatio: number;
    imports: string[];
    boundaries: string[];
    subjectMocked: boolean;
    verdict: Verdict;
  },
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): { evidence: string[]; rationale: string[] } {
  const evidence: string[] = [];
  const title = [...args.testCase.suite, args.testCase.title].join(" › ");

  evidence.push(
    `test case: "${title}" (lines ${args.testCase.line}-${args.testCase.endLine})`,
  );
  evidence.push(
    args.subject !== undefined
      ? `subject under test: ${args.subject}`
      : "subject under test: not identifiable from imports or filename",
  );

  evidence.push(
    `mocked collaborators (${args.meaningful.length}): ` +
      args.meaningful
        .slice(0, 6)
        .map((m) => `${m.target}${m.hollow ? " (no implementation)" : ""}`)
        .join(", ") +
      (args.meaningful.length > 6 ? `, +${args.meaningful.length - 6} more` : ""),
  );
  if (args.mockedRatio > 0) {
    evidence.push(
      `${Math.round(args.mockedRatio * 100)}% of this test's collaborators are ` +
        "replaced by doubles (the subject itself is excluded from the count)",
    );
  }
  if (args.imports.length > 0) {
    evidence.push(
      `production modules imported by the test: ${args.imports.slice(0, 6).join(", ")}`,
    );
  }
  if (args.boundaries.length > 0) {
    evidence.push(`mocked boundaries: ${args.boundaries.join(", ")}`);
  }

  evidence.push(
    `assertion categories observed: ${args.verdict.categories.join(", ")} ` +
      `(${args.verdict.interaction} mock-interaction, ${args.verdict.behavioural} behavioural)`,
  );
  for (const assertion of args.testCase.assertions.slice(0, 5)) {
    evidence.push(
      `  line ${assertion.line}: ${assertion.matcher} → ${assertion.category}`,
    );
  }
  if (args.testCase.mockConfigurations > 0) {
    evidence.push(
      `${args.testCase.mockConfigurations} call(s) in the body program the ` +
        "doubles' return values",
    );
  }

  evidence.push(
    args.subjectMocked
      ? "the module under test is itself among the mocked specifiers, so the " +
          "code being named by this test never runs"
      : "every assertion inspects a double's calls or arguments; none " +
          "inspects a value, state change, or error the subject produced — " +
          "so a behaviour change that keeps the same call shape cannot fail this test",
  );

  // The ladder trace is arithmetic about the finding, not a fact
  // about the code, so it leaves `evidence` and rides alongside it.
  return { evidence, rationale: scoreRationale(confidence, severity) };
}

/* ------------------------------------------------------------------ *
 * Import + subject analysis
 * ------------------------------------------------------------------ */

const IMPORT_RE =
  /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:^|\n)\s*(?:const|let|var)\s+[\s\S]*?=\s*(?:await\s+)?(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Module specifiers the test imports that plausibly hold production code.
 *
 * Read from source rather than from a parsed import list because the
 * `ParsedFile` surface does not carry imports and the repo-wide
 * `ImportGraph` resolves them to paths — this detector needs the
 * specifier as written, because that is what `vi.mock("./db")` names.
 */
function productionImports(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) continue;
    if (isTestInfrastructure(specifier)) continue;
    out.add(specifier);
  }
  return [...out].sort();
}

function isTestInfrastructure(specifier: string): boolean {
  return (
    /^(vitest|jest|@jest\/|sinon|chai|node:test|node:assert|assert|testdouble|@testing-library|msw|supertest|nock)/.test(
      specifier,
    ) || INFRASTRUCTURE_MOCKS.test(specifier)
  );
}

/**
 * Which module is this test about?
 *
 * Two signals, in order: an imported specifier whose basename matches the
 * test's basename (`billing.test.ts` importing `./billing`), then any
 * relative import at all when there is exactly one. Returns `undefined`
 * rather than guessing — an unidentified subject *lowers* confidence
 * rather than inventing one.
 */
function inferSubject(file: string, imports: string[]): string | undefined {
  const testBase = basename(file).replace(/\.[cm]?[jt]sx?$/, "");
  const relative = imports.filter((i) => i.startsWith("."));

  for (const specifier of relative) {
    const base = basename(specifier).replace(/\.[cm]?[jt]sx?$/, "");
    if (testBaseCovers(testBase, base)) return specifier;
  }
  // A test under `__tests__/` sits beside nothing; fall back to the sole
  // relative import when there is exactly one.
  if (relative.length === 1) return relative[0];
  void dirname;
  return undefined;
}

/**
 * Mocks that count toward saturation. Test infrastructure, timers, and
 * explicitly allowed specifiers are excluded — mocking a clock is
 * hygiene, not an alibi.
 */
function meaningfulMocks(
  mocks: MockDeclaration[],
  allowed: Set<string>,
): MockDeclaration[] {
  const seen = new Set<string>();
  const out: MockDeclaration[] = [];
  for (const mock of mocks) {
    if (mock.kind === "timers") continue;
    if (mock.kind === "fn") continue; // a bare local double, not a collaborator
    if (allowed.has(mock.target.toLowerCase())) continue;
    if (isTestInfrastructure(mock.target)) continue;
    if (seen.has(mock.target)) continue;
    seen.add(mock.target);
    out.push(mock);
  }
  return out;
}

/**
 * What fraction of this test's *collaborators* are replaced by doubles?
 *
 * The denominator is the union of two things:
 *
 *  - production modules the test imports, **excluding the subject** — the
 *    subject is what is being tested, not a collaborator, and counting it
 *    would cap a fully-saturated two-import test at 50%
 *  - modules the test mocks by specifier, which may be transitive
 *    collaborators the test never imports directly
 *
 * The numerator is the part of that union that is mocked. Defining it as
 * a union rather than as "imports only" is what makes the common shape
 * work: a test importing `./billing` and `./db` while mocking `./db` and
 * `./stripe` has replaced everything `./billing` talks to, and the ratio
 * should say so.
 */
function collaboratorMockRatio(
  imports: string[],
  mocks: MockDeclaration[],
  subject: string | undefined,
): number {
  const mockedSpecifiers = new Set(
    mocks.filter((m) => m.kind === "module").map((m) => m.target),
  );
  // Spy-style mocks target an imported binding rather than a specifier;
  // match them to the import whose basename agrees.
  const spyTargets = new Set(
    mocks
      .filter((m) => m.kind !== "module")
      .map((m) => m.target.split(".")[0]!.toLowerCase()),
  );

  const collaborators = new Set<string>();
  for (const specifier of imports) {
    if (subject !== undefined && specifier === subject) continue;
    collaborators.add(specifier);
  }
  for (const specifier of mockedSpecifiers) {
    if (subject !== undefined && specifier === subject) continue;
    collaborators.add(specifier);
  }
  if (collaborators.size === 0) return 0;

  let mocked = 0;
  for (const specifier of collaborators) {
    if (mockedSpecifiers.has(specifier)) {
      mocked += 1;
      continue;
    }
    const base = basename(specifier)
      .replace(/\.[cm]?[jt]sx?$/, "")
      .toLowerCase();
    if (spyTargets.has(base)) mocked += 1;
  }
  return mocked / collaborators.size;
}

/** Consequential boundaries the doubles stand in for. */
function boundariesCovered(mocks: MockDeclaration[]): string[] {
  const out = new Set<string>();
  for (const mock of mocks) {
    const boundary = classifyBoundary(mock.target);
    if (boundary) out.add(boundary.label);
  }
  return [...out].sort();
}

/** Did the test mock the very module it is named after? */
function mocksSubject(mocks: MockDeclaration[], subject: string): boolean {
  const subjectBase = basename(subject)
    .replace(/\.[cm]?[jt]sx?$/, "")
    .toLowerCase();
  return mocks.some((mock) => {
    if (mock.target === subject) return true;
    const base = basename(mock.target)
      .replace(/\.[cm]?[jt]sx?$/, "")
      .toLowerCase();
    return base === subjectBase;
  });
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.mock_saturation;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
