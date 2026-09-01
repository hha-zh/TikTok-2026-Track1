# Pre-Stage-7E Hardening and Targeted Verification

**Branch:** `feature/travel-lifecycle` · **Base HEAD:** `3a38e85`
**Working repository:** `/Users/qiang/Documents/agentlaunchpad/TikTok-2026-Track1`
(the task named a different absolute path that does not exist on this machine;
same branch, same HEAD, same tree)

**External provider / Ark / container executions: 0.** No Attempt #5.
**`apps/web` changes: none.** **Historical live-proof reports: unchanged.**

---

## 1. Executive Summary

Two CONFIRMED evidence-integrity defects were repaired, three first-pass
findings were verified and repaired, and four were verified and downgraded to
documented limitations. All seven Part 2 / Part 3 findings were independently
re-derived by an adversarial verifier whose default verdict was REFUTED; four
of them received a second, independent opinion.

**No verified finding proves a frozen governance claim to be currently false.**
No STOP condition was triggered. `authorize()` remains the only hard ALLOW/DENY
primitive, no middleware imports or branches on Travel semantics, and no
governed code path can amplify its own authority or budget.

The central correction this pass makes is not a security fix. It is that the
evidence contract was **stating things it had not observed** — a synthesized
task graph on the production path, a workload's verdict on itself served beside
ledger facts in an identical unlabelled shape, oracle keys whose names implied
predicates far stronger than their implementations, and canary checks that
could never fail. Every one of those is now either derived, labelled, or
absent, and every repair carries a regression test that fails when reverted.

The one genuinely security-classified finding (**H**, unauthenticated human
identity) is **reported here and deliberately NOT fixed**, per the instruction
to report exact severity before modifying code.

---

## 2. Confirmed Evidence Repairs (Part 1)

### 2.1 Live oracle semantic mismatch

Three keys in `scripts/stage7d-travel-proof.mjs` reused the frozen
deterministic oracle's names while asserting only that some event existed.

| Key | Was | Now |
| --- | --- | --- |
| `adaptive.realCandidateSnapshot` | `events.some(kind === "routing_decision")` | every decision must carry a non-empty `candidates` array |
| `adaptive.freshStateChangesWho` | any `routing_decision` for T5 exists | unchanged `delegationValue`, **rising** `delegationThreshold`, **rising** `runPressure`, and WHO actually changes `DELEGATE_SPECIALIST → REUSE_CURRENT` |
| `lifecycle.evidenceCorrelated` | `events.some(kind === "run_outcome")` | every `routing_decision.decisionId` must correlate to an `invocation_started` that reached the dispatch boundary |

`evidenceCorrelated` was strictly vacuous: `run_outcome` is written inside
`finish()` for **every** terminal outcome, FAILED included.

All three now mirror the frozen predicates in
`workload/travel-disruption/oracle.ts:64-80`. They were extracted from the
`.mjs` script into `live-proof-evidence.ts` as pure exported functions
specifically so they could be regression-tested; script-inline logic had **zero**
automated coverage.

### 2.2 Vacuous canary checks

| Check | Was | Now |
| --- | --- | --- |
| `governance.noRawChildHandoff` (`oracle.ts:61`) | `!evidenceText.includes("passportNumber")` — a token appearing nowhere in the repository (`git log -S` returns only the line that introduced it) | the published identity finding must expose **only** registered field names with bounded scalar values |
| `secretAudit.rawChildOutputAbsentFromParentView` | greps the view for `"assistant"`, which the view's schema structurally cannot contain | every parent-visible artifact must carry only schema-declared fields with values ≤ 64 chars |
| `secretAudit.protectedResourceLeakAbsent` | byte-identical duplicate of `protectedCanaryAbsentFromFlow` | checks passport `validThrough`, a field that can only appear if the passport body itself leaked |

`booking_name_key` deliberately **cannot** serve as a leak canary: it is a
legitimately delegated, schema-bounded field.

The 64-character bound was tightened from an initial 128 because a regression
test demonstrated 118 characters of model prose passing. The longest legitimate
Travel field value is a 25-character ISO timestamp.

### 2.3 Proof-report overwrite guard

`writeReport` now refuses to overwrite an existing report. Previously the fixed
path was written by **both** the success path (:278) and the preflight-failure
path (:53), so running `npm run travel:proof` on any machine without Docker or
ARK credentials replaced the PROVEN Attempt #4 artifact with a five-field
`NOT_RUN` stub in seconds — no live run required. A separately authorized
attempt now sets `TRAVEL_PROOF_REPORT` to a distinct filename. The NOT_RUN stub
write is best-effort so a refusal cannot mask the operator's real preflight error.

This was a first-pass finding, independently verified before the change.

### 2.4 Attempt #4 qualification — NOT retroactively upgraded

Attempt #4 persists `topology` (so T5 = `REUSE_CURRENT` is checkable) but does
**not** persist `candidates`, `delegationValue`, `delegationThreshold`,
`budget.runPressure`, or `decisionId`. The strengthened predicates therefore
**cannot** be reconstructed against it.

**The strengthened predicates apply to future authorized runs only.** The three
oracle keys as recorded in `reports/stage7d-travel-runtime-proof-attempt-4.json`
were produced by the weak predicates and must be read that way. The report was
not edited, and no stronger claim was synthesized for it.

---

## 3. Verification Results

Each item: refute-first verification, plus an independent second opinion for
every non-refuted SECURITY or ARCHITECTURE_CLAIM finding.

| ID | Verdict | Impact | Action | Sev | Second opinion |
| --- | --- | --- | --- | --- | --- |
| F | PARTIAL | EVIDENCE_INTEGRITY | FIX_BEFORE_UI | MEDIUM | n/a |
| G | CONFIRMED | UI_CONTRACT | FIX_BEFORE_UI | MEDIUM | n/a |
| H | PARTIAL | **SECURITY** | FIX_BEFORE_UI | MEDIUM | escalated from FIX_BEFORE_SUBMISSION |
| E | CONFIRMED | EVIDENCE_INTEGRITY | DOCUMENT_LIMITATION | LOW | n/a |
| L | PARTIAL | ARCHITECTURE_CLAIM | DOCUMENT_LIMITATION | LOW | agreed |
| N | CONFIRMED | ARCHITECTURE_CLAIM | DOCUMENT_LIMITATION | MEDIUM | verifiers split (see 5.2) |
| O | PARTIAL | ARCHITECTURE_CLAIM | DOCUMENT_LIMITATION | LOW | agreed |

### F — descriptor-absent GovernedRunView task graph → **PARTIAL, repaired**

The fabrication mechanism is real: with no descriptor, `buildGovernedRunView`
synthesized `TaskSpec`s from bare event `taskId`s and emitted `required: true`,
`dependencies: {tasks: [], artifacts: []}` and `producedArtifacts: []` as bare
typed fields with no quality marker. `index.ts:27` supplies no descriptor, so
production takes that branch.

PARTIAL rather than CONFIRMED because the branch is **latent, not active**: every
`taskId`-bearing event kind is emitted only by `ExecutionEngine`, which is
constructed only from `workload/**`; nothing reachable from `index.ts` imports
`workload/`, and `runTravelLifecycle` writes to a `mkdtemp` store. At HEAD the
production endpoint returns `tasks: []`. It activates the moment the adaptive
engine is driven from an HTTP-started run — which the existing
`POST /api/governance/runs` route already mints a parent RUN_TOKEN for.

The verifier also found the defect is **broader** than filed: these fields are
`DECLARED` (authored workload contract) even *with* a descriptor, and were
unlabelled in both branches.

**Repaired.** `label`, `required`, `dependencies` and `producedArtifacts` are now
`QualifiedEvidence<T>`: `DECLARED`/`WORKLOAD_DESCRIPTOR` when a descriptor
exists, `{value: null, quality: "UNAVAILABLE", source: "NONE"}` when it does not.
`taskId` stays OBSERVED and `status` stays DERIVED — both genuinely ledger-backed.
`required: !node.optional` is no longer emitted on the descriptor-less path:
absence of an `optional` flag is not evidence of requiredness.

### G — outcome EvidenceQuality → **CONFIRMED, repaired**

`outcome.domain`, `governanceOracle`, `adaptiveOracle` and `lifecycleOracle` were
`structuredClone`d verbatim from the caller-supplied descriptor into the same
object as `outcome.runtime`, which **is** ledger-derived, with no quality or
source field on any of the five — in a file that defines `EvidenceQuality` and
applies it to four sibling surfaces.

Impact is narrower than a governance flaw and entirely representational: a UI
would render `"Governance: passportBackendOnly ✓"` indistinguishably from
`run.status = COMPLETED`. That matters precisely because several of those
booleans are the workload's verdict on **itself**.

**Repaired.** `runtime` carries `quality: "DERIVED", source: "LEDGER"`; each
oracle block is wrapped `{value, quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR"}`.

Additionally repaired in the same contract:
`usageFeedback.laterDecisionsReferenceProjectedState` was the literal `true`
flagged as gap #1 in the teammate handoff. It is now **derived** from event
ordering — was any routing decision recorded after usage had already been
projected into run state — and labelled `DERIVED`.

### H — governed-run endpoint ownership → **PARTIAL, SECURITY, NOT fixed**

See §8. Reported, not modified, per instruction.

---

## 4. Refuted Findings

No Part 2 / Part 3 finding was fully refuted. Four were **materially narrowed**,
which is the same service: each was filed at a severity the source does not
support.

- **E** and **O** were filed as post-mint authority/budget amplification. Both are
  **trusted bootstrap configuration** performed by a privileged operator strictly
  before any governed execution. Calling them architecture violations would have
  been wrong.
- **L**'s consequence was overstated; one third of it (expiry) is wrong for the
  only production case that exists.
- **F**'s consequence ("presents invented facts") is currently latent, not active.

One finding from the prior first-pass audit was fully REFUTED — the claim that
Attempt #4's `noRawChildHandoff` / `earlyRouterTopology` were hard-coded
literals. It is recorded here so it is not raised again, and it was not reopened.

---

## 5. Confirmed Remaining Findings

### 5.1 L — Return Gate read leg performs no authorization (LOW, documented)

`readArtifact` (`governance/artifacts.ts:430-451`) is the only Return Gate leg
calling neither `resolveGrant` nor `authorize`. Its entire policy is three data
predicates: owner short-circuit, `published`, `recipients.includes(...)`. It
appends no ledger event. `createArtifact` and `publishArtifact` both run the full
pipeline and ledger their denials.

Concrete consequence, as narrowed by both verifiers: **bounded revocation latency
on re-reads, plus an unledgered read.** After a human revokes a grant, that
principal's run token stays valid until its own `exp` — at most 15 minutes — and
`GET /api/artifacts/:id` keeps returning 200 for artifact UUIDs it **already
knows** and was **already a recipient of**. Every other agent-reachable route
(`/api/resources/*`, `/api/tools/*`, artifact create/publish, delegations) closes
immediately.

Not repaired: changing it would alter frozen Return Gate semantics, and no
frozen claim is currently false. Recorded as a limitation.

### 5.2 N — `producedArtifactTypes` unenforced on the unpublished commit branch (MEDIUM, documented)

In `commitArtifacts` (`adaptive/execution-engine.ts:590-646`), when a
`ProducedArtifact` has `publishedArtifactId === undefined` the engine pushes an
`own_task_output` carrying the executor's raw value and `continue`s, skipping all
four downstream checks including the `producedArtifactTypes` contract. The engine
performs no schema validation of its own; validation lives only inside
`publishArtifact → validatePublication`.

**The two verifiers split on action** (`DOCUMENT_LIMITATION` vs `FIX_BEFORE_UI`),
and the disagreement is recorded rather than resolved. Both agree there is **no
authority consequence**. The second verifier judged the finding slightly
*stronger* than the first. In the shipped fixture demo this is not hypothetical:
`A_VALIDATED` and `A_FINAL` are committed, made ready-gating for T6, and briefed
into T6's context under declared types that are never checked.

Not repaired: Part 3 explicitly instructs against automatic fixes here, and it
touches frozen middleware.

### 5.3 E — live proof token-cap rewriting (LOW, documented)

`stage7d-travel-proof.mjs:104-110` writes `envelope.maxTokens` and
`runState.maxTokens` to a caller-chosen cap (default 120k; Attempt #4 ran 150k)
against a frozen 12,000. Verified ordering: **strictly before** `createApp`,
`app.listen`, the parent token mint, and any `authorize()` call, in a throwaway
probe store. No governed code path raises its own `maxTokens` or lowers its own
`tokensUsed`.

Classification: trusted bootstrap configuration plus an evidence-labelling
weakness — the report's budget claims are graded against the cap the script
itself wrote, which the artifact does not label as operator-chosen.

### 5.4 O — Travel root Envelope bootstrap mutation (LOW, documented)

`startTravelRun` (`fixtures.ts:37-55`) calls `startGovernedRun` with no authority
options, then overwrites six fields of the freshly minted root Envelope. Verified:
**three** of the six writes change anything (scope sets replaced; `maxChildren`
2 → 4); `envelope.maxTokens`, `envelope.depth` and `run.maxTokens` are written
with values identical to the minted ones.

No governed principal, executor, container, or HTTP route can reach
`startTravelRun`, and the write completes before the first `authorize()` in all
three call sites. This is trusted fixture initialization using the wrong seam —
`startGovernedRun` accepts no authority options, so **no sanctioned seam exists**.
Recommended for submission-time cleanup, not now.

---

## 6. Authority / Budget Claim Assessment

**Intact.** Verified mechanically, not from documentation:

- `authorize()` remains the only hard ALLOW/DENY primitive.
- No governed code path writes `maxTokens` or reduces `tokensUsed`. Both
  cap-rewriting findings (E, O) are operator bootstrap strictly preceding
  execution, unreachable from any governed principal or HTTP route.
- The frozen middleware diff since the freeze point is still exactly one added
  read-only file. This pass modified that file (`governed-run-view.ts`,
  +65/−19) and it remains a pure read projection: grep for `authorize`,
  `store.mutate`, `ledger.`, `resolveGrant`, `deriveChildEnvelope` returns
  **nothing**. No ALLOW/DENY, attenuation, budget, routing, or envelope
  semantics changed.
- HG-14 remains **PARTIAL**. Not upgraded.

The honest qualification: the **evidence for** the Authority × Budget story in
Attempt #4 is weaker than its key names implied (§2.1), and the live cap was
operator-chosen (§5.3). The architecture is intact; the historical proof of it
is narrower than the report's names suggest.

---

## 7. GovernedRunView Contract Assessment

After F and G, every field is one of: OBSERVED (ledger event), DERIVED
(computed from ordered ledger facts), DECLARED (authored workload contract,
sourced `WORKLOAD_DESCRIPTOR`), or UNAVAILABLE (backend has nothing to say).

The remaining structural gap is **not** truthfulness but coverage: production
supplies no descriptor, so the task graph is honestly `UNAVAILABLE` rather than
honestly populated. A UI can now render that correctly instead of rendering
invented defaults. Supplying a real descriptor requires a backend-owned workload
registry, which does not exist at HEAD and must not be improvised by putting
workload identity into generic middleware.

Two known thin spots, unchanged by this pass:
`routingDecisions[].explanation` is still always `UNAVAILABLE`, and there is
still no owner-scoped run discovery endpoint.

---

## 8. Security Assessment — Finding H

**Verdict: PARTIAL. Impact: SECURITY. Severity: MEDIUM. NOT FIXED.**

**Mechanism — confirmed unconditionally.** Human identity is asserted, never
proved. `verifyIdentity`'s human branch (`identity.ts:72-81`) is a bare array
lookup of the raw `x-principal-id` string against `store.principals`. The sole
Fastify hook (`app.ts:146` — the only `addHook` in `apps/server/src`; there is no
route-level `preHandler` anywhere) passes only `{ principalHeader }` and never
the Authorization header. `GET /api/governance/runs/:id` keys ownership on that
self-asserted value (`app.ts:249`). The only cryptographic credential in the
server is the agent RUN_TOKEN HMAC. **In every configuration, including hardened
ones, there is no cryptographic notion of which human is calling.** The ownership
test is a scoping selector over a client-chosen string, not authentication.

**Consequence — real, runtime-demonstrated, but narrower than filed.** "Any
client that can reach the API" is config-dependent. The only perimeter credential
is `config.authToken`, a single shared secret, and `app.ts:191-198` skips the
check entirely when it is empty. Postures:

- **(a)** default `npm run dev`: `NODE_ENV` unset → `development`, `HOST` defaults
  to `0.0.0.0`, no token → reachable and anonymous on the local network.
- **(b)** loopback bind → attacker needs local access.
- **(c)** shared token set → **horizontal privilege escalation between
  authenticated principals**, not anonymous read.

What an attacker past the perimeter gets for one request naming a repo-constant
principal id: the full `GovernedRunView` for a run they do not own — routing
decisions and candidate sets, budget horizon, the delegation tree with
attenuation, context projections including withheld-artifact ids and reasons,
and `boundedFields`, the full field content of every artifact the run published
to its owner.

**Not a governance-core defect.** `authorize()`, the Envelope pipeline and
everything under `middleware/**` are unaffected; this is application-layer
perimeter authentication.

**Proposed minimal fix, ready but NOT applied** (`app.ts` + `config.ts`, ~8 lines,
no new IAM, no middleware change): refuse the human header when there is no
perimeter credential **and** the bind is not loopback — collapsing posture (a)
into posture (b) and leaving (b) and (c) behaving exactly as they do today.

**Awaiting your decision**, per "report exact security severity BEFORE modifying
code." Note it would change `npm run dev` behaviour on a non-loopback bind.

---

## 9. FIX_BEFORE_UI

| ID | Item | Status |
| --- | --- | --- |
| 2.1 | live oracle semantic mismatch | **DONE** |
| 2.2 | vacuous canaries / duplicate audit key | **DONE** |
| 2.3 | proof-report overwrite guard | **DONE** |
| G+ | `laterDecisionsReferenceProjectedState` literal | **DONE** (derived) |
| F | descriptor-absent task-graph fabrication | **DONE** (labelled) |
| G | outcome block provenance | **DONE** (labelled) |
| H | unauthenticated human identity | **BLOCKED on your decision** (§8) |

## 10. FIX_BEFORE_SUBMISSION

1. **H**, if not taken now.
2. **O** — give `startGovernedRun` an authority-options seam so a workload
   declares root authority at mint time instead of overwriting after.
3. **E** — label the live cap in the report as operator-chosen, so budget claims
   are not read as graded against the frozen cap.
4. Attempt #4's three weakened oracle keys must be described honestly wherever
   the live proof is cited (§2.4). `docs/TEAMMATE_HANDOFF_REVIEW.md:413` currently
   implies only two literal successes existed.
5. Documentation debt from the prior audit: root `package.json` description,
   `BACKLOG.md`, `TRAVEL_LIFECYCLE.md` status line, and its enum/negative-oracle
   contract drift.

## 11. Deferred / Limitations

- **L** — Return Gate read leg: ≤15-minute revocation latency on re-reads of
  already-known, already-recipient artifacts; reads are unledgered.
- **N** — `producedArtifactTypes` unenforced when `publishedArtifactId` is
  absent; verifiers split on urgency; no authority consequence.
- **Attempt #4 cannot be retroactively strengthened** (§2.4).
- Low-priority items `k`, `p`, `q`, `r`, `t`, `u` untouched per instruction.
  Note `u` is real and was hit during this work: the suite must run from
  `apps/server`, and it rewrites `reports/PHASE6.md` and
  `reports/phase6-measurement.json` with machine-local timings — both were
  restored with `git checkout`.
- Not covered: covert channels, hostile multi-tenant container isolation,
  provider identity, browser UX.

## 12. Stage 7E Readiness Matrix

| UI block | Readiness | Note |
| --- | --- | --- |
| **P0** Run Header | READY_WITH_DECLARED/DERIVED_LABELS | `workload` is `DECLARED` or honestly `null` |
| **P0** Task / Lifecycle Graph | NOT_READY *(production)* / READY_WITH_LABELS *(descriptor supplied)* | now honestly `UNAVAILABLE` instead of fabricated; needs a backend-owned descriptor registry |
| **P0** Runtime Decision Card | READY_WITH_DECLARED/DERIVED_LABELS | candidates + horizon OBSERVED; `explanation` still `UNAVAILABLE` |
| **P0** Delegation Tree | READY | parent/child, lifecycle, attenuation all ledger-derived |
| **P0** Governance Timeline | READY | normalized, correlated, sanitized |
| **P1** Authority × Budget/Horizon | READY | `maxToolCalls.enforced: false` is honest |
| **P1** Parent → Child attenuation | READY | retained/removed derived from envelopes |
| **P1** Context included/withheld | READY | per-invocation ids + typed reasons |
| **P1** Return Gate | READY_WITH_LABELS | see L: reads unledgered |
| **P1** Usage feedback → later routing | READY_WITH_DECLARED/DERIVED_LABELS | correlation now DERIVED, not asserted; `explanation` still absent |

**Not ready and out of scope of this pass:** owner-scoped run discovery. The
inspector still needs a known run ID.

---

## 13. Validation

- Focused: Travel suite **89/89** (was 63; +26 new hardening tests).
- New file `stage7d-hardening.test.ts`: **32 tests**, all REGRESSION-named cases
  fail when the repair is reverted.
- Full: `npm run check` → **408/408 across 34 files** (was 376/33), typecheck and
  both builds pass.
- `git diff --check` → clean.
- `apps/web` changed: **NO**. External provider runs: **0**.
- Historical live-proof reports changed: **NO** (`git status reports/` clean;
  the byte-for-byte hash tests pass).
- Frozen middleware semantics changed: **NO** (read-only projection only).
