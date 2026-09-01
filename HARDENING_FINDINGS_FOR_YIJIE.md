# Pre-Stage-7E Hardening — Findings

**Branch:** `feature/travel-lifecycle` · **Base:** `3a38e85`
**Follows:** `AUDIT_7A-7D_FINDINGS.md` (first-pass audit) — this pass **verified**
those leads and acted on them.
**No Ark/provider runs. No Attempt #5. `apps/web` untouched. No report edited.**

---

## How to read this

Every item below was independently re-derived by a verifier whose **default
verdict was REFUTED**, and every non-refuted SECURITY / ARCHITECTURE finding got
a **second, independent opinion**. So "CONFIRMED" here means someone actively
tried to knock it down and couldn't — unlike the first-pass audit, where roughly
two thirds of items were unverified leads.

Four items came back **materially narrower than they were filed**. That's in
§1, first, because two of them were filed as architecture violations against
your work and are not.

---

## 1. Cleared — filed harder than the source supports

### E — "the live proof rewrites token caps post-mint and grades itself against them"
**Verdict: trusted bootstrap configuration. LOW. Not a violation.**

The mechanics are real — `stage7d-travel-proof.mjs:104-110` writes
`envelope.maxTokens` / `runState.maxTokens` to 120k default (150k for Attempt #4)
against a frozen 12,000. But the verified ordering is **strictly before**
`createApp`, before `app.listen`, before the parent token mint, and before any
`authorize()` call, in a throwaway probe store. No governed code path raises its
own `maxTokens` or lowers its own `tokensUsed`.

Calling this runtime self-escalation would have been wrong. The only real
residue is evidentiary: the report's budget claims are graded against a cap the
operator chose, and the artifact doesn't say so. → §4.

### O — "Travel bootstrap amplifies root authority after mint"
**Verdict: trusted fixture initialization. LOW. Not a violation.**

`startTravelRun` (`fixtures.ts:37-55`) does overwrite six fields of the minted
root Envelope — but only **three** actually change anything (scope sets replaced,
`maxChildren` 2 → 4). `envelope.maxTokens`, `envelope.depth` and `run.maxTokens`
are written with values **identical** to the minted ones.

No governed principal, executor, container, or HTTP route can reach
`startTravelRun`, and the write completes before the first `authorize()` in all
three call sites. The project's "runtime cannot self-amplify" claim is **not**
false.

The fair version: it uses the wrong seam, because `startGovernedRun` accepts no
authority options — **no sanctioned seam exists**. Worth adding one before
submission, not now.

### Also cleared
The first-pass claim that Attempt #4's `noRawChildHandoff` / `earlyRouterTopology`
were hard-coded literals was **REFUTED** at HIGH confidence and, per instruction,
was not reopened.

---

## 2. Repaired — already done, please don't redo

All in your files. `npm run check` is green at **408/408 across 34 files** (was
376/33).

### 2.1 Three live oracle keys asserted far less than their names implied
`scripts/stage7d-travel-proof.mjs`

| Key | Was | Now |
| --- | --- | --- |
| `adaptive.realCandidateSnapshot` | `events.some(kind === "routing_decision")` | every decision must carry a **non-empty `candidates` array** |
| `adaptive.freshStateChangesWho` | any `routing_decision` for T5 exists | unchanged `delegationValue`, **rising** threshold, **rising** `runPressure`, and WHO actually changes `DELEGATE_SPECIALIST → REUSE_CURRENT` |
| `lifecycle.evidenceCorrelated` | `events.some(kind === "run_outcome")` | every `routing_decision.decisionId` must correlate to an `invocation_started` |

`evidenceCorrelated` was strictly vacuous — `run_outcome` is written inside
`finish()` for **every** terminal outcome, FAILED included.

All three now mirror your own frozen predicates in `oracle.ts:64-80`. I moved
them out of the `.mjs` into `live-proof-evidence.ts` as pure functions
**specifically so they could be tested** — script-inline logic had zero coverage.

### 2.2 Canary checks that could never fail
- `oracle.ts:61` — `noRawChildHandoff` grepped for `"passportNumber"`, a token
  that appears nowhere in the repo (`git log -S` returns only the commit that
  introduced the line). Now: the published identity finding must expose **only**
  registered field names with bounded scalar values.
- `stage7d-travel-proof.mjs` — `rawChildOutputAbsentFromParentView` grepped the
  view for `"assistant"`, which the view's schema structurally cannot contain.
  Now: every parent-visible artifact must carry only schema-declared fields.
- `protectedResourceLeakAbsent` was a **byte-identical duplicate** of
  `protectedCanaryAbsentFromFlow`. Now checks passport `validThrough` — a field
  that can only appear if the passport body itself leaked. (`booking_name_key`
  can't serve as a canary; it's legitimately delegated.)

### 2.3 The proof script could destroy Attempt #4 without running
`writeReport` is reached by **both** the success path (:278) **and the
preflight-failure path (:53)**. So `npm run travel:proof` on any machine without
Docker or ARK credentials replaced the PROVEN artifact with a five-field
`NOT_RUN` stub in seconds — no live run needed.

It now **refuses to overwrite an existing report**; a new authorized attempt sets
`TRAVEL_PROOF_REPORT` to a distinct filename. The stub write is best-effort so a
refusal can't mask your real preflight error.

### 2.4 Evidence contract: fabricated and unlabelled fields
`middleware/evidence/governed-run-view.ts` (still a pure read projection —
`authorize` / `store.mutate` / `resolveGrant` all return **0 matches**)

- **F:** with no descriptor — which *is* production, `index.ts:27` — the view
  synthesized TaskSpecs from bare event `taskId`s and emitted `required: true`
  and empty dependency arrays as plain fields. Now `label` / `required` /
  `dependencies` / `producedArtifacts` are `QualifiedEvidence<T>`: `DECLARED`
  with a descriptor, `UNAVAILABLE` without. `taskId` stays OBSERVED, `status`
  DERIVED.
- **G:** the four oracle blocks were `structuredClone`d verbatim from the
  descriptor into the same object as ledger-derived `outcome.runtime`, unlabelled
  — so the workload's verdict on *itself* rendered identically to `run.status`.
  Now each carries `quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR"`.
- `laterDecisionsReferenceProjectedState` (gap #1 in your handoff) was the literal
  `true`. Now **derived** from event ordering.

### 2.5 Regression tests
New `apps/server/src/workload/travel-disruption/stage7d-hardening.test.ts` — 32
tests, every `REGRESSION:`-named case fails if the repair is reverted. Travel
suite 63 → 89.

One of these caught a bug in **my own** repair: my first bounded-value threshold
was 128 chars and a test showed 118 characters of model prose passing it.
Tightened to 64 against a 25-char longest legitimate value.

---

## 3. Still open, no authority consequence

### L — Return Gate read leg performs no authorization (LOW)
`governance/artifacts.ts:430-451` — `readArtifact` is the only leg calling
neither `resolveGrant` nor `authorize`, and appends no ledger event.
`createArtifact` / `publishArtifact` both run the full pipeline.

Narrowed consequence: **≤15-minute revocation latency on re-reads** of artifact
UUIDs the principal **already knows** and was **already a recipient of**, plus an
unledgered read. Every other agent-reachable route closes immediately. Not
repaired — that would change frozen Return Gate semantics, and no frozen claim
is currently false.

### N — `producedArtifactTypes` unenforced on the unpublished branch (MEDIUM)
`adaptive/execution-engine.ts:590-646` — when `publishedArtifactId` is undefined
the engine pushes `own_task_output` with the raw value and `continue`s, skipping
the declared-type contract and all schema validation.

In the fixture demo this isn't hypothetical: `A_VALIDATED` and `A_FINAL` are
committed, made ready-gating for T6, and briefed into T6's context under declared
types that are never checked. **The two verifiers split** on urgency
(`DOCUMENT_LIMITATION` vs `FIX_BEFORE_UI`) — recorded rather than resolved. Both
agree: no authority consequence.

---

## 4. Needs your call — the submission claim

**Attempt #4's three keys cannot be retroactively upgraded.** The report persists
`topology` (so T5 = `REUSE_CURRENT` is checkable) but **not** `candidates`,
`delegationValue`, `delegationThreshold`, `budget.runPressure`, or `decisionId`.

So the strengthened predicates in §2.1 apply to **future runs only**. The three
keys as recorded in `reports/stage7d-travel-runtime-proof-attempt-4.json` were
produced by the weak predicates and have to be read that way. I did not edit the
report and did not synthesize a stronger claim for it.

**Concretely:** `docs/TEAMMATE_HANDOFF_REVIEW.md:413` says Stage 7D.3 removed
"the live proof's two literal oracle successes," which reads as though the rest
of the live oracle is real evidence. These three name-only checks were the rest.
That line needs rewording wherever the live proof is cited.

Also for submission: the live run's cap was **operator-chosen** (150k vs frozen
12k) and the report doesn't label it as such, so its budget claims shouldn't be
read as graded against the frozen cap.

**Note this does not weaken the architecture claim** — Authority × Budget is
intact and was re-verified mechanically. It weakens the *historical evidence for*
it, which is a wording problem, not a code problem.

---

## 5. Security — needs a decision (not yours to fix alone)

**H — human identity is asserted, never proved. MEDIUM. Deliberately unfixed.**

`verifyIdentity`'s human branch (`identity.ts:72-81`) is a bare array lookup of
the raw `x-principal-id` string. The sole hook (`app.ts:146`) never sees the
Authorization header. `GET /api/governance/runs/:id` keys ownership on that
self-asserted value (`app.ts:249`). The only cryptographic credential in the
server is the agent RUN_TOKEN HMAC.

Severity is MEDIUM, not HIGH, because it's config-dependent: with
`config.authToken` set it's horizontal escalation between authenticated
principals; on default `npm run dev` (`0.0.0.0`, no token) it's anonymous. An
attacker past the perimeter gets the full `GovernedRunView` for a run they don't
own — including `boundedFields`, the content of every artifact published to the
owner.

This is **application-layer perimeter auth, not a governance-core defect**:
`authorize()` and everything under `middleware/**` are unaffected. Fix is ~8
lines in `app.ts` + `config.ts`, drafted but not applied — it would change
`npm run dev` behaviour on a non-loopback bind.

---

## 6. What's verified good

Re-derived mechanically this pass, not taken from docs:

- `authorize()` is still the only hard ALLOW/DENY primitive.
- Frozen middleware diff since the freeze point is still **one added read-only
  file**; no pre-existing middleware file has ever been modified.
- No governed code path writes `maxTokens` or reduces `tokensUsed`.
- HG-14 still **PARTIAL** — not quietly upgraded anywhere.
- Full detail: `docs/PRE_STAGE7E_HARDENING.md`.
