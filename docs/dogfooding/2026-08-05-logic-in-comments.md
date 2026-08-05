# `logic_in_comments`: the first R3 precision item, measured

**Charge:** Logic in the Alibi.
**Complaint:** [field notes](./2026-08-05-choreograph-field-notes.md) —
"had the worst false-positive rate". Fired on five files in a repo that
documents its reasoning unusually well; **none were actionable**.
**Status vs `main`:** [re-verified](./2026-08-05-choreograph-reverify.md)
— all ten hits reproduced, same files.

---

## The cause was not either of the two the notes proposed

The field notes suggested:

1. drop confidence hard when the comment references no identifier
   appearing in the adjacent code, or
2. split the charge into prescriptive vs explanatory.

**(1) already exists** — the detector will not emit at all unless at
least one domain term is absent from the following 16 lines. And it
would not have silenced the representative hit anyway, which does
reference adjacent identifiers.

**(2) is the hard one**, and it is still open.

Reading the evidence of all ten hits — rather than reasoning about the
detector — found a third cause nobody had proposed, and it accounted for
three of the ten:

| file | domain term claimed | where it actually came from |
|---|---|---|
| `src/lib/types.ts` | `auth` | "**Auth**ored by the Curator persona" |
| `src/lib/job-processor.ts` | `utc` | "captured that o**utc**ome" |
| `apps/web/lib/buildNonce.ts` (cal.com) | `plan` | inside a longer word |
| `apps/web/modules/auth/verify-view.tsx` (cal.com) | `payment` | inside a longer word |

`DOMAIN_TERMS` were matched with `String.includes`. Neither
`types.ts` nor `job-processor.ts` has anything whatever to do with
authentication or timezones.

This is **trap 1 from the release plan** — *never resolve a symbol by
name alone*, the rule that came out of `2e9b2da`'s 0.98-confidence chain
through `Set.prototype.has` — in its dumbest possible form. A concept is
not mentioned just because its letters appear.

---

## The fix, and the thing it nearly broke

Whole-word matching, with a **closed set of inflections** allowed after
the term (`-s`, `-es`, `-ed`, `-ing`, `-er`, `-ers`, `-ies`, plus the
`e`-drop before `-ing`/`-ed`). The allowlist is the point: it is what
separates `owner` + `s` from `auth` + `ored`.

**A plain word-boundary rule was tried first and was wrong.** It broke a
cal.com finding worth keeping — "Do not move this before authorization
check" — because `auth` had been doing double duty as a stem. Word
boundaries fix the false positives *and* stop a stem covering the words
built on it, and only the first half of that is desirable.

So the vocabulary is now explicit, grouped by concept:

```ts
auth: ["auth", "authz", "authn", "authorize", "authorise",
       "authorization", "authorisation", "authenticate", "authentication"],
```

Grouped rather than listed flat because `admin` and `administrator` are
one concept, and counting them twice would inflate both `confidence` and
`severity` — the scores are computed from `domainTerms.length`.

The nearby-code check is deliberately **looser in one direction**: it
requires the leading word boundary (so `outcome` still does not encode
`utc`) but allows any trailing letters, so `cached`, `caching` and
`cacheKey` all count as the code encoding `cache`. That test decides
whether a finding is emitted at all, so a miss there is a false
positive — the detector claiming the code is silent about something it
plainly says. Over-crediting the code costs one finding; under-crediting
it costs the user's trust.

---

## Measured

| repo | `logic_in_comments` | total findings |
|---|---|---|
| choreograph.cc @ `5107cce` | **10 → 7** | 491 → 488 |
| cal.com | 11 → **11** | 4,638 → 4,638 |
| crimes (self-scan) | 2 → 2 | 1,792 → 1,792 |
| hono | 0 → 0 | 377 → 377 |
| drf | 0 → 0 | 88 → 88 |
| pydantic | 0 → 0 | 487 → 487 |
| **eval fixtures (all 15)** | 2 → 2 | **finding sets byte-identical** |

**cal.com's flat 11 is the interesting number, and it is not a null
result.** Two findings left and two arrived:

- **Left:** the `plan` and `payment` substring matches above.
- **Arrived:** two findings a *spurious nearby match* had been
  suppressing. The nearby check used `includes` too, so code containing
  `author` counted as encoding `auth`, and the finding was dropped
  before anyone saw it.

One of the two that arrived, in
`packages/features/bookings/lib/handleNewBooking/getRequiresConfirmationFlags.ts`:

```ts
// If the user is not the owner of the event, new booking should be always pending.
// Otherwise, an owner rescheduling should be always accepted.
// Before comparing make sure that userId is set, otherwise undefined === undefined
return !!(userId && originalRescheduledBookingOrganizerId === userId);
```

The comment says **owner**; the code says **Organizer**. That is the
charge, exactly — a rule stated in prose that the adjacent code names
differently. It was being hidden by a bug.

So the headline moved by nothing on cal.com while the finding set got
better in both directions. **Reported as a flat number rather than as
"−18%", because the flat number is what happened.**

---

## Not changed, and why

**Five of choreograph's remaining seven are `admin`**, and four of those
five sit in files whose *path* contains `admin`
(`src/app/api/admin/jobs/route.ts` and friends). The nearby-code check
looks at the next 16 lines only, so in an admin route — where "admin" is
encoded by the file's position rather than by a token near the comment —
it reports the concept as absent.

A path-aware rule is the obvious next move and it is **deliberately not
in this change**:

- The release plan is explicit that only one thing gets tuned at a time,
  because the eval aggregate cannot attribute two.
- It is a judgement call, not a bug. "Admin regen always means really
  re-run, never no-op fast-path" in an admin route may well *be* an
  unenforced rule worth reporting — the code has to actually force the
  re-run, and nothing here checks that it does.
- Four hits on one repository is not a corpus measurement. Tuning on it
  would be fitting to a sample of one, which is how §15's ~728 false
  positives nearly happened in reverse.

**The prescriptive-vs-explanatory split is still open**, and it is the
one the field notes actually asked for. The representative hit —

> "Panorama — 360° equirectangular bonus piece (day % 3 == 2; never
> required for publish). Authored by the Curator persona."

— is now gone for the right reason (there was no domain concept in it at
all), but a comment that *is* explanatory and *does* name a domain
concept would still fire. That is the remaining work, and it needs a
corpus measurement of the split before a rule is chosen.

---

## Eval baseline

**Not re-run, and this is the evidence for why.** The versioning policy
asks for a re-run when a change moves findings. This one does — on real
repositories — but **every one of the 15 eval fixtures produces a
byte-identical set of fingerprints before and after**, verified by
`cmp` on the sorted fingerprint list per fixture.

The agents are handed the same scan, so the only thing a re-run could
measure is agent nondeterminism. `evals/results/0.18.4/` stands.

Patch bump to `0.20.1` per policy, so the version that would key a
future baseline moves with the change.
