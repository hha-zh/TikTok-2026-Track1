# Independent Audit — Stages 7A–7D

**Target:** `feature/travel-lifecycle` @ `3a38e85`
**Date:** 2026-08-31
**Method:** 6 independent read-only review agents, then adversarial verification of
MEDIUM+ findings by separate agents whose default verdict was *refuted*.
**Scope limit:** read-only. No provider, Ark, or container runs. No files modified.

## How to read the confidence column

| Label | Meaning |
| --- | --- |
| **CONFIRMED** | A second agent tried to refute it and failed. Treat as fact. |
| **REFUTED** | Failed verification. Recorded so it isn't re-raised. |
| *first-pass* | Found by one agent, **not yet verified**. Some of these will be wrong. |

The verification phase was **stopped early**. Only 4 of ~15 MEDIUM+ findings were
verified — 3 survived, 1 was refuted. The refuted one looked as solid as the rest
before it was checked, so please treat *first-pass* items as leads, not verdicts.

Where several independent dimensions found the same thing, it is marked
**convergent (N/6)** — that is meaningful signal even without formal verification.

---

## 1. What held up

These were checked mechanically and are genuinely solid:

- **The freeze is real.** `git diff --stat 3ee049d..HEAD -- apps/server/src/middleware/`
  is exactly one file, `evidence/governed-run-view.ts`, **+267 / −0**. No pre-existing
  middleware file was modified. The new file is read-only in fact, not just by
  convention: only `store.snapshot()` and `structuredClone`, no `store.mutate`, no
  ledger append, no `authorize` call.
- **Dependency direction is clean.** `rg` for `workload/`, `phase6`, and
  `travel|passport|itinerary|flight|disruption|accommodation|transport|rebook`
  across the whole middleware tree returns only false positives. The generic
  governor does not know the workload exists.
- **Topology is Router-chosen, not hard-coded.** A read-only probe of real router
  assignments produced `T1/T2: declared benefit 3.33 clears threshold 1.30` and
  `T5: declared benefit 3.33 below threshold 4.80 → REUSE`.
- **Child attenuation is genuine.** The Identity child's grant comes from
  `deriveChildEnvelope` via `DelegationService`; the branded `DerivedEnvelope` is the
  only thing `persistChild` writes. It retains `{identity/passport, IdentityVerification}
  × {read, model:invoke, artifact:create, artifact:publish}`, loses `delegatable`
  entirely (`[]`), depth 1→0, maxChildren→0, maxTokens `min(2400, parent remaining)`.
- **No secrets committed.** Full sweep of `reports/`, `docs/`, `scripts/` for key/JWT/AWS
  patterns found only UUIDs, `http://host.docker.internal:3000`,
  `volc-agent-runtime:local`, and `.env.example` placeholders. The passport canary is
  the synthetic `P-SYNTHETIC-8841`; no passport body, prompt text, or raw model output.
- **The view cannot leak credentials.** `buildGovernedRunView` reads only
  `governanceEvents`/`envelopes`/`principals`/`runStates`/`grantStates`/`artifacts`
  and never `mockResources`. `RunTokenService` and `ARK_API_KEY` never touch the store.
- **Baseline is accurate.** 376/376 across 33 files, and §14's sub-counts are exact
  (Travel 63/63 across 4 files, Stage 7D.3 focused 10/10).

---

## 2. Confirmed findings

### 2.1 Live 7D oracle reuses the frozen oracle's key names for checks that cannot fail
**CONFIRMED ×2 (HIGH confidence) · convergent (3/6) · `scripts/stage7d-travel-proof.mjs:185,188,194`**

Three keys emitted into `reports/stage7d-travel-runtime-proof-attempt-4.json` are bare
existence checks over ledger event kinds, published under names that the frozen
deterministic oracle (`workload/travel-disruption/oracle.ts:64-80`) defines with
materially stronger predicates:

| Key | Live implementation | Frozen oracle requires |
| --- | --- | --- |
| `adaptive.realCandidateSnapshot` | `events.some(e => e.kind === "routing_decision")` | every recorded decision carries a **non-empty candidates array** |
| `adaptive.freshStateChangesWho` | `events.some(kind === "routing_decision" && payload.taskId === T5_VALIDATE)` | that the decision **changed WHO** on fresh state |
| `lifecycle.evidenceCorrelated` | `events.some(e => e.kind === "run_outcome")` | actual cross-event correlation |

`evidenceCorrelated` is strictly vacuous: `execution-engine.ts:300-308` writes
`run_outcome` inside `finish()`, which runs for **every** terminal outcome including
FAILED. All three are logically implied by other conjuncts already inside the same
`deriveOraclePassed` conjunction, so they add no evidence while adding apparent breadth.

Both verifiers stated they attempted refutation and could not.

**Why it matters:** this is the likely judge question — *"how do you know the live run
proved adaptive routing?"* The honest answer today is narrower than the report's
key names imply.

**Note on the §16 wording:** `docs/TEAMMATE_HANDOFF_REVIEW.md:413` says Stage 7D.3
removed "the live proof's two literal oracle successes," which reads as though the
remainder is real evidence. These name-only checks are the remainder.

### 2.2 Canary strings that can never be false
**CONFIRMED (HIGH confidence) · convergent (3/6)**

- `workload/travel-disruption/oracle.ts:61` — `noRawChildHandoff` greps evidence for
  `"passportNumber"`. `rg passportNumber` over the repo returns **exactly that one line**,
  and `git log -S 'passportNumber' --all` returns only the commit that introduced
  `oracle.ts`. The conjunct cannot be false.
- `scripts/stage7d-travel-proof.mjs:214` — `rawChildOutputAbsentFromParentView` greps a
  `GovernedRunView` for `"assistant"`, a token the view's schema structurally cannot
  contain.
- `scripts/stage7d-travel-proof.mjs:211` — `protectedResourceLeakAbsent` is a
  **byte-identical duplicate** of `protectedCanaryAbsentFromFlow`, inflating the
  apparent breadth of the protected-resource audit.

The verifier's correction is worth quoting: *"evidence hygiene, not a governance hole."*
The boundary itself is sound — no path was found by which raw child output reaches the
parent. These are tests that would pass regardless.

---

## 3. Refuted — please do not act on this one

### Attempt #4's `noRawChildHandoff` / `earlyRouterTopology` were hard-coded literals
**REFUTED (HIGH confidence) · `reports/stage7d-travel-runtime-proof-attempt-4.json:201`**

The literal facts check out — `git show 9bd1b18:scripts/stage7d-travel-proof.mjs` does
contain both as literal `true`, and the derivation helpers in `live-proof-evidence.ts`
(added in `a6cbe89`) have never executed inside a live lifecycle. But the verifier found
both values **independently corroborated by other live evidence recorded in the same
frozen report**, and the gap is already disclosed. Overstated at HIGH; not a defect.

Recorded here so it doesn't get re-raised by the next reader.

---

## 4. First-pass findings — not yet verified

### 4.1 Stage 7D proof integrity

| # | Finding | Sev |
| --- | --- | --- |
| a | **The fixed report path is written by the preflight-failure path too** (`stage7d-travel-proof.mjs:15`). §16 already flags the overwrite risk; it is worse than described. A rerun on any machine lacking Docker or ARK credentials replaces the PROVEN artifact with a five-field `NOT_RUN` stub within seconds — no live run required to destroy it. | HIGH |
| b | **Live `oracle.domain` values are dictated to the model** (`live-runtime.ts:126`). Every domain value is handed to the model verbatim in its prompt and additionally pinned to the ground-truth answer by single-value artifact enums. §13's "Live Travel lifecycle COMPLETE / Attempt #4 PROVEN" rests partly on this. | HIGH |
| c | **The offline revalidation re-asserts the report's own conclusions** (`stage7d-revalidate-attempt4.mjs:24-26`). `oracleRevalidated: PASS` ANDs 17 of 19 booleans straight out of the report being validated; only two fields are reconstructed, and the evidence needed to recompute the rest was never persisted. §11 cites it as independent confirmation. | MED |
| d | **Live domain oracle is narrower than the frozen one** (`stage7d-travel-proof.mjs:174`): 4 keys vs 5, dropping `combinationConsistent` entirely and reducing `approvalRequired` to a bare enum read with no linkage to the SGD 300 threshold the contract specifies. | MED |
| e | **The proof rewrites the token caps it then grades itself against** (`stage7d-travel-proof.mjs:108`): mutates `envelope.maxTokens` and `runState.maxTokens` directly in the store post-mint to a caller-chosen cap (default 120k; Attempt #4 ran 150k) — 10×+ the frozen 12,000. | MED |

### 4.2 Evidence contract — blocks Stage 7E

| # | Finding | Sev |
| --- | --- | --- |
| f | **The descriptor-absent path fabricates the task graph** (`governed-run-view.ts:142`). Production is descriptor-absent (`index.ts` passes only `{store, runTokens, ledger}`). The view synthesizes `TaskSpec`s from event `taskId`s, then emits `required` / `dependencies` / `producedArtifacts` from those invented nodes as plain fact. This is §16's gap #2, but the real behaviour is fabrication, not degradation. | HIGH |
| g | **The whole `outcome` block is an unlabeled pass-through** (`governed-run-view.ts:259-262`) · convergent (4/6). `outcome.domain.summary`, `domain.oracle`, `governanceOracle`, `adaptiveOracle`, `lifecycleOracle` are copied verbatim from the caller-supplied descriptor with **no `EvidenceQuality` marker**, while neighbouring fields carry one — so the run's verdict on itself is served beside ledger-derived events with nothing distinguishing them. §16 flags only `laterDecisionsReferenceProjectedState`. | HIGH |
| h | **Ownership check trusts a forgeable header** (`app.ts:249`). `GET /api/governance/runs/:id` resolves the caller's human identity from `x-principal-id` alone with no proof of possession, so any client that can reach the API can read another human's governed run by naming their principal id. This is the endpoint 7E will consume. | MED |
| i | **Hardcoded quality literals** (`governed-run-view.ts:212`): `horizon` spreads `payload.budget` wholesale and stamps a constant `quality: "OBSERVED"` on a block containing DECLARED config (`parallelCapacity` from RouterPolicy, `depthRemaining` from the envelope) and a DERIVED value (`runPressure`). | MED |
| j | **Both "does not expose" tests plant canaries where the view cannot look** (`governed-run-view.test.ts:102`): the passport and run-token canaries live only in `database.mockResources`, which `buildGovernedRunView` never reads. Both tests pass with the Return Gate and Resource Gate deleted. | MED |
| k | `attenuation.removed.childDelegation` uses `&&` where either condition alone removes delegation (`governed-run-view.ts:237`) — a child with depth 0 but maxChildren > 0 provably cannot delegate, yet is reported as retaining it. | LOW |

### 4.3 Governance surface

| # | Finding | Sev |
| --- | --- | --- |
| l | **The read leg of the Return Gate performs no authorization** (`middleware/governance/artifacts.ts:430`). `readArtifact` enforces owner, publication state and recipient, but never calls `resolveGrant` or `authorize` — so revocation, expiry and budget exhaustion do not close the read path, unlike create/publish which run the full pipeline. | MED |
| m | **In the live path the orchestrator, not the isolated child, does the work for T4** (`live-runtime.ts:299`). The server process calls `readManagedResource` with the child's identity, derives the four booleans itself, embeds them plus the exact publish command in the child's prompt, then requires the child's artifact to equal what it already computed. | MED |
| n | **`producedArtifactTypes` is unenforced on the REUSE_CURRENT path** (`middleware/adaptive/execution-engine.ts:598`). `commitArtifacts` `continue`s past every check once `publishedArtifactId` is undefined, skipping the declared-type contract and all schema validation for `own_task_output`. | MED |
| o | **Travel bootstrap rewrites the minted root Envelope in place** (`workload/travel-disruption/fixtures.ts:43`). `startTravelRun` mutates exercisable/delegatable scopes, maxChildren, maxTokens and depth directly in the store after `startGovernedRun` minted them — granting the parent new *exercisable* resources and raising maxChildren above the frozen `PARENT_MAX_CHILDREN`. | MED |
| p | A persisted child Envelope is built outside `deriveChildEnvelope()` in `execution-engine.test.ts:68` — the `DelegationPort` seam permits it, and the engine's own suite hand-builds an Envelope literal with `parentGrantId` and pushes it to the store. Test-only, but it means the seam is not structurally closed. | LOW |
| q | `phase6/authority-budget.test.ts:199` assigns `grantState.tokensUsed` / `runState.tokensUsed` directly — the only place outside `projections.ts` that does, bypassing the `tokens_consumed` append. | LOW |
| r | `live-runtime.test.ts:242` checks prompts for `RUN-TOKEN-CANARY`, a string only ever seeded in a *different* test file's store, and never checks the real minted `parentToken` / `runtimeRunToken` the prompts could actually leak. | LOW |

### 4.4 Docs vs code

| # | Finding | Sev |
| --- | --- | --- |
| s | **`docs/TRAVEL_LIFECYCLE.md:272` contract drift.** The frozen contract requires enum specs to be "finite enum sets derived from the deterministic bundle" and requires the oracle to prove invalid combinations invalid. The implementation pins each option enum to the single ground-truth value and implements no negative case. §16 reports no drift. | MED |
| t | §16 attributes the stale "middleware-free Agent platform starter kit" description to `apps/server/package.json`, which has **no `description` field**. The string is in the **root** `package.json`. | LOW |
| u | Running the suite from the repo root fails 2 report-hash tests (they resolve `../../reports` off cwd); 376/376 requires running from `apps/server`. Also, the suite **rewrites** `reports/PHASE6.md` and `reports/phase6-measurement.json` with machine-local timings — the auditor restored both with `git checkout`. | LOW |

Honesty items that are **clean**: HG-14 remains PARTIAL, dispatch-granularity is
disclosed, and no doc was found quietly upgrading a PARTIAL claim to COMPLETE.

---

## 5. Suggested split

**For Yijie (evidence + submission-claim work):**
2.1, 2.2, 4.1a–e, 4.4s — everything touching Attempt #4, the oracles, the proof
scripts, and the frozen contract. 4.1a is the urgent one: it is a live risk to
irreplaceable evidence, and anyone running `npm run travel:proof` destroys it.

**For implementation (this session):**
4.2f–k (the 7E view-layer gaps, now a superset of §16's four) and 4.3l–r.

**Unowned pending decision:** 4.3o and 4.1e both write governance state directly
in the store. Neither is inside frozen middleware, but both weaken what the caps mean.

---

## 6. What this audit did not check

- No new live Ark/container run — Attempt #4 is treated as historical evidence.
- Provider identity beyond configured path and reported usage.
- Container isolation against a hostile multi-tenant adversary.
- Covert-channel resistance.
- Browser UX (Stage 7E does not exist yet).
- **11 of ~15 MEDIUM+ findings above are unverified.**
