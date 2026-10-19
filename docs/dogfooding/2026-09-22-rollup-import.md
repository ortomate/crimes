# Rollup import: 2026-09-22

**Entries:** 54 new of 54 in the rollup
**Recorded by:** angryassistant (22), nosie-app (18), thickeningtime (6), rolecred (5), orto.band (3)
**Produced by crimes:** 0.26.0 (54)
**Verdicts:** fp (54)

Untriaged. These are verdicts other sessions recorded in their own
repos, imported mechanically. A verdict is one reader's judgement, not
an established fact about the detector — read the reasons before acting.
A run of `fp` notes that all say the same thing is the signal worth
chasing; a single `fp` usually is not.

## By detector

| Detector | Entries | Repos |
| --- | --- | --- |
| `direct_date` | 11 | 2 |
| `swallowed_error` | 9 | 4 |
| `high_fan_in_fan_out` | 8 | 1 |
| `config_drift` | 5 | 2 |
| `magic_domain_literal_scatter` | 4 | 3 |
| `duplicated_policy` | 2 | 2 |
| `duplicated_role_status_plan_check` | 2 | 2 |
| `large_file` | 2 | 1 |
| `name_behavior_mismatch` | 2 | 1 |
| `hardcoded_localhost` | 1 | 1 |
| `logic_in_comments` | 1 | 1 |
| `near_duplicate_block` | 1 | 1 |
| `option_bag_junk_drawer` | 1 | 1 |
| `orphaned_destination` | 1 | 1 |
| `return_shape_roulette` | 1 | 1 |
| `sync_io_in_hotpath` | 1 | 1 |
| `unsafe_retry` | 1 | 1 |
| `weak_test_signal` | 1 | 1 |

## The reasons

### `direct_date`

- **fp** · angryassistant · `direct_date::src/lib/pipeline/daily-cron.ts::`
  - The cron core receives one injected Date. This constructor derives a fixed three-day reminder deadline from that injected instant; it does not read the system clock or create nondeterministic branching.
- **fp** · angryassistant · `direct_date::src/app/api/cron/weekly-email/route.ts::`
  - The HTTP boundary captures one instant and injects it into runWeeklyCron. All eligibility branches live in the directly tested core, which does not read the system clock.
- **fp** · angryassistant · `direct_date::src/app/(dashboard)/integrations/actions.ts::`
  - The server action captures one request-boundary instant and passes it into all domain and persistence work.
- **fp** · angryassistant · `direct_date::src/app/(dashboard)/integrations/page.tsx::`
  - The server-render boundary captures one instant and passes it into calendar account loading.
- **fp** · angryassistant · `direct_date::src/app/api/integrations/google/callback/route.ts::`
  - The OAuth callback captures one request-boundary instant and injects it into state expiry and token expiry decisions.
- **fp** · angryassistant · `direct_date::src/app/api/integrations/google/connect/route.ts::`
  - The OAuth initiation route captures one request-boundary instant and injects it into signed state creation.
- **fp** · angryassistant · `direct_date::src/lib/integrations/google-calendar.ts::`
  - The only clock read is the production default for an injected now() dependency; fetch decisions and timestamps use that injected value and a fixed-clock regression test. The other new Date parses a stored last_sync_at timestamp and does not read wall time.
- **fp** · nosie-app · `direct_date::app/api/interview/[token]/complete/route.ts::`
  - The only clock read is the default production boundary. The handler injects now(), captures it once, and direct regression coverage proves every completion timestamp uses that fixed instant.
- **fp** · angryassistant · `direct_date::src/lib/email/inbound-reply-claim.ts::`
  - The Date is derived from an injected fixed request instant to calculate the stale cutoff; it does not read the system clock.
- **fp** · angryassistant · `direct_date::src/app/api/webhooks/email-reply/route.ts::`
  - The request boundary captures the system instant exactly once and injects it through all claim decisions; domain tests use a fixed instant.
- **fp** · angryassistant · `direct_date::src/lib/pipeline/commitment-invitation.ts::`
  - The Date constructor receives the validated proposal dueAt value. It does not read the system clock, decide a branch, or add wall-clock nondeterminism.

### `swallowed_error`

- **fp** · angryassistant · `swallowed_error::src/lib/pry/chat-contract.ts::parsePryModelResponse → safeParse`
  - Invalid model JSON is an expected input boundary. The function returns a tested safe plain-text response with no memories and sectionComplete=false; logging model content or routine parse errors would add noise and could expose user text.
- **fp** · angryassistant · `swallowed_error::src/lib/integrations/google-account-oauth.ts::verifyGoogleOAuthState → parse`
  - Invalid signed-state JSON is attacker-controlled input. The contract intentionally fails closed to null; callers redirect to a generic error, and logging malformed payloads would create attacker-controlled noise.
- **fp** · angryassistant · `swallowed_error::src/lib/integrations/google-calendar-accounts.ts::fetchAdditionalGoogleCalendarAccountBatch → accountClient`
  - The catch deliberately redacts provider payloads and secrets, classifies the error through safeGoogleCalendarErrorKind, persists a safe account error, and returns a typed failed=true result. The caller exposes failedAccountCount while retaining healthy account events, so failure is neither discarded nor reported as success.
- **fp** · angryassistant · `swallowed_error::src/lib/integrations/status.ts::setIntegrationStatus → recordProductEvent`
  - Product telemetry is intentionally best effort after the authoritative integration status write. The catch emits a bounded telemetry-error category and deliberately excludes the rejected value because it can contain database details; the rejection boundary and redaction are directly tested.
- **fp** · nosie-app · `swallowed_error::lib/services/twilio.ts::sendSms → text`
  - The caught response-body read is immediately followed by an unconditional throw for the non-OK response. A failed body read removes optional diagnostic detail but cannot turn the provider failure into success.
- **fp** · angryassistant · `swallowed_error::src/lib/integrations/oauth-state.ts::verifySignedOAuthState → parse`
  - Malformed signed OAuth state is attacker-controlled input. Verification intentionally fails closed to null after signature validation; callers return a generic invalid-state redirect, and logging payload or parse details would create attacker-controlled noise.
- **fp** · angryassistant · `swallowed_error::src/app/api/integrations/oura/callback/route.ts::cookieValue → decodeURIComponent`
  - A malformed OAuth nonce cookie is untrusted input. The callback intentionally treats decode failure as an absent nonce and fails closed to the generic invalid-state redirect without logging attacker-controlled cookie data.
- **fp** · rolecred · `swallowed_error::app/api/jobs/dispatch/route.ts::GET → runClaimedJob`
  - The catch records a token-fenced retry or terminal failure in Postgres, marks analysis state retryable, emits a privacy-safe bounded log, and returns HTTP 500. The caller does not see success and the failure is durably actionable without exposing provider details.
- **fp** · thickeningtime · `swallowed_error::lib/glossary-copy.ts::copyGlossaryLink → track`
  - Plausible telemetry is deliberately best effort after clipboard success. The user action must remain successful when analytics is unavailable, and a direct regression test proves this boundary.

### `high_fan_in_fan_out`

- **fp** · nosie-app · `high_fan_in_fan_out::lib/services/email.ts::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change email.ts.
- **fp** · nosie-app · `high_fan_in_fan_out::app/(app)/developers/page.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this page.
- **fp** · nosie-app · `high_fan_in_fan_out::app/(app)/projects/[id]/results/page.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this page.
- **fp** · nosie-app · `high_fan_in_fan_out::app/admin/accounts/page.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this page.
- **fp** · nosie-app · `high_fan_in_fan_out::app/i/[token]/page.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this page.
- **fp** · nosie-app · `high_fan_in_fan_out::components/interview/interview-experience.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this component.
- **fp** · nosie-app · `high_fan_in_fan_out::components/projects/study-settings.tsx::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change this component.
- **fp** · nosie-app · `high_fan_in_fan_out::lib/interview/tokens.ts::`
  - Untouched-file percentile shift caused by adding the focused extraction-data module; this branch did not change tokens.ts.

### `config_drift`

- **fp** · angryassistant · `config_drift::src/lib/supabase/public-config.ts::NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - Supabase documents sb_publishable keys as safe and intended for browser bundles. NEXT_PUBLIC is required for Next.js client access; authorization remains enforced by RLS.
- **fp** · angryassistant · `config_drift::src/lib/supabase/public-config.ts::NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - Supabase documents the legacy anon key as a low-privilege public browser key. This fallback supports the current deployment while it migrates to a publishable key; authorization remains enforced by RLS.
- **fp** · angryassistant · `config_drift::src/app/api/integrations/google/connect/route.ts::NODE_ENV`
  - NODE_ENV is supplied by the Next.js runtime and should not be configured in .env.example.
- **fp** · nosie-app · `config_drift::tests/integration/setup.ts::NOSIE_TEST_SUPABASE_URL`
  - Wrapper-owned ephemeral test value, exported from supabase status by scripts/run-integration-tests.sh and asserted before use. It is intentionally not user configuration and does not belong in .env.example.
- **fp** · nosie-app · `config_drift::tests/integration/setup.ts::NOSIE_TEST_SUPABASE_SERVICE_ROLE_KEY`
  - Wrapper-owned ephemeral test credential, exported from local supabase status and asserted before use. It must not be persisted in .env.example.

### `magic_domain_literal_scatter`

- **fp** · nosie-app · `magic_domain_literal_scatter::app/(app)/projects/[id]/self-test-actions.ts::::owner_user_id`
  - PostgREST column name used once for the explicit account-owner authorization gate. It is a schema identifier, not duplicated business policy; removing the predicate would weaken future multi-user isolation.
- **fp** · rolecred · `magic_domain_literal_scatter::app/api/stripe/webhook/route.ts::::processed`
  - The three processed literals are unrelated bounded states in Stripe event handling, analysis job return control, and Stripe event parsing. They do not encode shared policy.
- **fp** · orto.band · `magic_domain_literal_scatter::scripts/music-benchmark-preflight.mjs::::status`
  - The benchmark preflight status field is a local serialized-state discriminator. The other reported status fields belong to unrelated album, admin review, and UI domains; centralizing them would couple separate policies.
- **fp** · orto.band · `magic_domain_literal_scatter::scripts/music-benchmark-provider-state.mjs::::status`
  - This module is already the centralized benchmark provider-state policy. The other reported status fields belong to unrelated admin review, album, and UI domains, so sharing one constant would create cross-domain coupling.

### `duplicated_policy`

- **fp** · nosie-app · `duplicated_policy::components/interview/interview-session-api.ts::status "404" "503" variants::20848c984c7e`
  - The guards belong to unrelated provider contracts: Twilio DELETE treats HTTP 404 as idempotent absence, while the browser session client maps HTTP 503 to provider unavailability. Sharing response.status syntax does not make them one policy.
- **fp** · angryassistant · `duplicated_policy::src/app/(dashboard)/settings/accountability-scope-controls.tsx::status "disconnected" "paused" variants::56b8f51ca5d9`
  - Unrelated state machines: Oura connection status and user-owned accountability jurisdiction status deliberately use different values and authorization rules.

### `duplicated_role_status_plan_check`

- **fp** · nosie-app · `duplicated_role_status_plan_check::components/contacts/transcript-panel.tsx::::role.agent`
  - Untouched-file finding relocation: this branch removes ad-hoc role filtering from the completion route and does not modify transcript-panel.tsx or add another role policy.
- **fp** · orto.band · `duplicated_role_status_plan_check::scripts/music-benchmark-preflight.mjs::::status.rejected`
  - Promise.allSettled result.status is a JavaScript settlement discriminator; MasterclassReview status is a product review state. They are unrelated domains and must not share a policy helper.

### `large_file`

- **fp** · thickeningtime · `large_file::fixtures/bossary/thickening-time-glossary.json::`
  - Generated deterministic transfer fixture, not a code module; splitting it would break the single atomic import envelope.
- **fp** · thickeningtime · `large_file::fixtures/bossary/thickening-time-import.json::`
  - Generated deterministic data fixture, not a code module; splitting it would break the exact single-request import artifact and add no reasoning safety.

### `name_behavior_mismatch`

- **fp** · thickeningtime · `name_behavior_mismatch::scripts/export-bossary-glossary.mjs::buildGlossaryExport`
  - createHash computes a deterministic in-memory value and does not mutate external state; the build name matches the returned artifact.
- **fp** · thickeningtime · `name_behavior_mismatch::scripts/export-bossary-glossary.mjs::parseCanonicalTerms`
  - TypeScript createSourceFile parses an in-memory string into an AST and has no external side effect; parseCanonicalTerms neither executes source nor performs I/O.

### `hardcoded_localhost`

- **fp** · rolecred · `hardcoded_localhost::src/lib/http/origin.ts::`
  - Development-mode fallback only — function throws in production before reaching the localhost return. The other mention is in a JSDoc comment.

### `logic_in_comments`

- **fp** · nosie-app · `logic_in_comments::tests/integration/setup.ts::::371cded31aae`
  - The nearby guards require both wrapper values and reject every non-local URL before reassigning the runtime keys. The comment records why the second assignment exists; the safety rule is enforced in code.

### `near_duplicate_block`

- **fp** · angryassistant · `near_duplicate_block::tests/unit/google-access-revocation.test.ts::::6da23b62edff`
  - These are independent Vitest hoisted mock registries for unrelated Google revocation and Oura callback boundaries. Extracting a shared helper would couple separate test modules and obscure each test contract; the similar declaration shape contains no duplicated business rule.

### `option_bag_junk_drawer`

- **fp** · nosie-app · `option_bag_junk_drawer::lib/services/elevenlabs.ts::buildAgentPayload`
  - buildAgentPayload accepts the explicit named AgentConfig interface, and now destructures all owned fields at the boundary; this is not an implicit option bag.

### `orphaned_destination`

- **fp** · rolecred · `orphaned_destination::app/(auth)/auth/callback/route.test.ts::`
  - Vitest route test file is not a Next.js destination; detector misclassifies the .test.ts sibling under app.

### `return_shape_roulette`

- **fp** · angryassistant · `return_shape_roulette::src/lib/pipeline/commitment-acceptance.ts::applyPreparedCommitmentResponse`
  - Function has an explicit Promise<CommitmentResponseResult> discriminated-union return type; action is the discriminator and every branch is directly contracted.

### `sync_io_in_hotpath`

- **fp** · thickeningtime · `sync_io_in_hotpath::scripts/export-bossary-glossary.mjs::`
  - One-shot local CLI and node:test helper only; it is never imported by the application or used in a server hot path.

### `unsafe_retry`

- **fp** · rolecred · `unsafe_retry::src/lib/completion/recompute.ts::ensureCertificate → …insert`
  - Idempotency is enforced by a unique index on certificates(quicklift_id) + a post-failure existence check added in this commit. The retry loop only varies public_slug (via nanoid); the database constraint prevents duplicate certificates per quicklift.

### `weak_test_signal`

- **fp** · nosie-app · `weak_test_signal::tests/e2e/cron.spec.ts::::cron tick rejects missing/wrong secrets and runs with the right one`
  - The Playwright test has four explicit expect calls covering missing, wrong, and matching Bearer secrets plus response accounting. The detector misses assertions because the async test callback spans multiple lines.

