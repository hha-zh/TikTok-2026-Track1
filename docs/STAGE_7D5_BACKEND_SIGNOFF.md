# Stage 7D.5 — Final Backend Sign-Off

**Branch:** `feature/travel-lifecycle` · **Base HEAD:** `3a38e85`
**Repository:** `/Users/qiang/Documents/agentlaunchpad/TikTok-2026-Track1`
(the task text named a different absolute path that does not exist here)

**External provider runs: 0.** No Attempt #5. **`apps/web` changed: NO.**
**Historical Attempt reports changed: NO.**

Supersedes nothing; extends `docs/PRE_STAGE7E_HARDENING.md`. Findings already
cleared (E, O) or accepted (oracle repairs, canary repairs, report-overwrite
protection, GovernedRunView evidence-quality repairs) were **not reopened**.

---

## 1. N — root cause

`ExecutionEngine.commitArtifacts` (`middleware/adaptive/execution-engine.ts:590`)
branches on one condition: `item.publishedArtifactId === undefined`.

The branch exists for a sound reason, stated in its own comment: same-principal
output does not cross a principal boundary, and when a task IS delegated the
ContextBroker withholds raw child output from the parent. **Confidentiality is
therefore already handled by the boundary, not by this function.**

The defect is that the same branch also skipped **integrity**. Falling into the
unpublished path bypassed all four downstream checks — store existence,
`stored.published`, owner match, and the `node.producedArtifactTypes[item.id]`
contract at :628. The engine performs no schema validation of its own; the only
validation in the system lives inside `publishArtifact → validatePublication`.

So a task could satisfy a **typed** dependency with arbitrary output simply by
**declining to publish**. Two concerns — confidentiality across principals, and
the integrity of a declared artifact contract — had been collapsed into a single
branch condition that only answers the first.

**Why the two paths differ, precisely:** `publishedArtifactId` is set only when a
value crossed the Return Gate, which is mandatory for a *different principal's*
output. It was being used as a proxy for "has been validated". It is not one: it
is a proxy for "crossed a principal boundary". Same-principal output is
legitimately unpublished and was therefore legitimately unvalidated.

### Travel tasks that exercise the affected branch

| Task | Artifact | Declares a type? | Affected |
| --- | --- | --- | --- |
| T0 `understand_disruption` | `A_CONSTRAINTS` | no | no contract to enforce |
| T1 `search_transport` | `A_TRANSPORT` | `TransportOptions` | **yes, when routed REUSE** (`adapter.ts:119`) |
| T2 `search_accommodation` | `A_ACCOMMODATION` | `AccommodationOptions` | **yes, when routed REUSE** |
| T3 `plan_local_arrival` | `A_ROUTE` | no | no contract to enforce |
| T4 `verify_identity` | `A_IDENTITY` | `IdentityVerification` | **yes, when routed REUSE** |
| T5 `validate_recovery_plan` | `A_VALIDATED` | `ValidatedRecoveryPlan` | **yes, always** (`adapter.ts:170`) |
| T6 `final_recovery_plan` | `A_FINAL` | `FinalTravelRecoveryPlan` | **yes, always** (`adapter.ts:178`) |

T5 and T6 always take the unpublished branch and always declare a type, and both
are ready-gating for downstream work. This was not hypothetical.

---

## 2. N — exact fix

`middleware/adaptive/execution-engine.ts`, inside the `publishedArtifactId ===
undefined` branch, before the artifact is pushed:

- if the node declares `producedArtifactTypes[item.id]`, the value must be a
  field record — a non-object, array, or `null` fails closed;
- the declared type's registered schema is looked up in
  `database.artifactSchemas` (already in scope; `commitArtifacts` snapshots the
  store on entry);
- `validatePublication(schema, declaredType, fields)` is called directly. This is
  the **same pure validator** `publishArtifact` uses, so there is one schema
  language, not two;
- any failure returns `{ ok: false, error }`, which the engine already treats as
  a task failure — so the artifact is never committed and can never satisfy a
  downstream dependency.

**What was deliberately NOT done**, per the constraints:

- same-principal output is **not** routed through the cross-principal Return
  Gate — no artifact is created, nothing is published, no `artifact_created` or
  `artifact_published` event is emitted (pinned by a test);
- no change to `authorize()`, the Envelope pipeline, the Router, the TaskGraph,
  the ContextBroker, or the artifact subsystem;
- tasks that declare **no** type keep their previous behaviour exactly — there is
  no contract to enforce, and inventing one would have broken T0 and T3.

One import added (`validatePublication`), one guarded block, ~30 lines.

---

## 3. N — regression tests

New: `apps/server/src/middleware/adaptive/own-task-output-contract.test.ts`, 8 tests.

| Test | Asserts |
| --- | --- |
| admits conforming output | the happy path still completes end to end |
| **REGRESSION** undeclared field name | fails closed |
| **REGRESSION** value outside its field spec | fails closed |
| **REGRESSION** output is not a field record | fails closed |
| **REGRESSION** declared type has no registered schema | fails closed |
| **REGRESSION** invalid artifact satisfying a dependency | downstream task never becomes ready |
| untyped output unchanged | T0/T3-shaped tasks keep working |
| no Return Gate involvement | zero artifacts stored; no `artifact_created` / `artifact_published` |

**Mutation-verified:** reverting the repair fails exactly the 5 `REGRESSION:`
tests; the 3 that still pass are the "unchanged behaviour" cases, which correctly
do not depend on it.

---

## 4. H — current authentication model

Verified by source audit, answering the six questions asked.

**Q1 — what `APP_AUTH_TOKEN` / `config.authToken` protects.** A transport
door-lock, not an identity. `config.ts:35-40` declares it optional with regex
quantifier `*`, so the empty string is valid and there is no default;
`config.ts:54` normalises it to `""`. Startup enforcement (`config.ts:56-62`)
fires **only** when `NODE_ENV === "production"` **and** `HOST` is not loopback.
In development, test, and loopback-bound production it is fully optional.

**Q2 — which routes verify it.** Exactly one place: the tail of the sole
`onRequest` hook, `app.ts:191-208`. There are no route-level `preHandler`s and no
second hook. Its skip list: `!config.authToken` (**the default**), any non-`/api/`
URL, `/api/health`, `/api/auth`. A separate earlier bypass at `app.ts:171-179`
returns early for a valid RUN_TOKEN bearer across a six-path allowlist — that one
is intentional and correct.

**Q3 — how a human principal is selected.** `app.ts:151` reads
`x-principal-id` verbatim; `app.ts:180-184` passes **only** `principalHeader` into
`verifyIdentity`, omitting the Authorization header entirely, so the RUN_TOKEN
branch is skipped by construction; `identity.ts:72-74` does a single array
`find` for equality against `store.principals`. No secret, signature, nonce, or
expiry anywhere on this path.

**Q4 — can the browser choose an arbitrary principal.** Yes for the *choice*, no
for the *string space*. The value must pre-exist in `store.principals`
(`identity.ts:72-77`) or the request 401s with `PRINCIPAL_NOT_FOUND`, and
`kind === "human"` is enforced. But the two valid ids are hard-coded public
constants in `fixtures.ts`, so the constraint excludes typos, not attackers.

**Q5 — existing session→principal mapping.** **NONE.** Exhaustive negative
evidence: no session, cookie, login, JWT, or signature machinery anywhere;
`@fastify/cookie`, `@fastify/session`, `@fastify/jwt` are absent from
`package.json`. The nearest existing mechanism is the agent RUN_TOKEN HMAC
(`run-token.ts`), which binds a token to a *runtime* principal — never to a human.

**Q6 — application model. `SINGLE_OWNER_DEMO`**, on the code's own evidence:

1. `Principal` (`types.ts:1-6`) has no secret, hash, or key field. The two humans
   are hard-coded literals with nothing but ids.
2. The only human-facing secret is explicitly shared. The browser unlock screen
   says so verbatim: *"This shared demo token is configured by the platform
   operator."* (`App.tsx:283-291`). One secret shared by all viewers cannot
   express multi-user authentication even in principle.
3. `apps/web` **never sends `x-principal-id`** — zero occurrences. There is no
   multi-user client path today.

---

## 5. H — verified attack / trust boundary

Finding H is real, but **in every shipped posture the attacker must already be
past the single perimeter this application has.** There is no posture in which an
anonymous internet user crosses a per-user credential, because no per-user
credential exists to cross.

| Posture | Config | Precondition to exploit | Reality |
| --- | --- | --- | --- |
| **A** `npm run dev` — **the default** | `HOST=0.0.0.0`, `NODE_ENV=development`, `authToken=""` | TCP reach to port 3000 on any interface | `curl -H 'x-principal-id: wtan' …` is the entire exploit; both ids are public constants |
| **B** loopback bind | `HOST=127.0.0.1` | local access to the machine | already implies far more capability than the endpoint grants |
| **C** shared token set | `authToken` non-empty | possession of the shared token | **horizontal escalation between authenticated principals**, not anonymous read |

**Newly discovered and worse than posture A suggests: `.env` is never loaded.**
There is no dotenv dependency and no `--env-file`; `config.ts:52` reads
`process.env` directly. `README.md:180-186` instructs the developer to
`cp .env.example .env` and run `npm run dev`. **Nothing reads that file.** An
operator who dutifully sets `APP_AUTH_TOKEN` in `.env` is still running posture A
on `0.0.0.0` while believing they are in posture C. This is a documentation and
tooling defect that silently defeats the only perimeter the app has, and it is
independent of the identity question.

**What an attacker past the perimeter obtains:** the complete `GovernedRunView`
for a run they do not own — routing decisions and candidate sets, budget horizon
and token deltas, the delegation tree with attenuation, context projections
including withheld-artifact ids and reasons, and `boundedFields`, the full field
content of every artifact the run published to its owner.

**Not a governance-core defect.** `authorize()`, the Envelope pipeline,
`deriveChildEnvelope`, the gates and the ledger are unaffected. This is
application-layer perimeter authentication.

---

## 6. H — candidate fixes

Three options were analysed independently. **No option was implemented** — Stage
7D.5 stops here for human approval, as instructed.

| | **A** perimeter fail-closed | **B** per-principal secrets | **C** declared single-owner |
| --- | --- | --- | --- |
| Shape | hoist the shared-token check above identity resolution; refuse the human header unless the perimeter was proven or the peer is loopback | `APP_PRINCIPAL_TOKENS=wtan:s1,…`; require a matching `x-principal-token` before `verifyIdentity` | `GOVERNANCE_OWNER_PRINCIPAL` names the one human; stop reading `x-principal-id` on human routes |
| Security property | *no unauthenticated remote party may assert a human identity* | *possession of wtan's secret is required to act as wtan* | *the caller can no longer choose which principal to be* |
| Binds auth → principal | **No** | **Yes** | **No** |
| Unnecessary IAM | No | **Yes** | No |
| Code scope | **~15 lines** of logic in `app.ts`; ~55–75 total across 4 files | ~40–54 production lines, **~130–195 total across 10–11 files** | ~25 production lines; ~110 total across 10 files |
| `npm run dev` | unchanged (browser reaches `/api` via the Vite proxy, so the peer is loopback) | **breaks** — every human route 401s until `APP_PRINCIPAL_TOKENS` is exported, and `.env` does not load | easier — works with zero configuration |
| Stage 7E browser | works; SPA must send `x-principal-id` (it sends none today) | works; new `x-principal-token` header, CORS verified fine | **strongest** — browser sends nothing new at all |
| Verdict | ACCEPTABLE | ACCEPTABLE | ACCEPTABLE |

**Each option's own stated failure mode**, which matters more than the code:

- **A** — "a reachability fix wearing an authentication commit message." Past the
  perimeter, `x-principal-id` is still a two-element public autocomplete.
  **Blocking caveat:** `apps/web/package.json:7` runs `vite --host 0.0.0.0`, so a
  LAN caller can go through port 5173 and be laundered into a loopback peer. The
  improvement is illusory until that flag is dropped **in the same commit**.
- **B** — "a password with the login flow and the password store deleted." No
  expiry, rotation, revocation, hashing, or rate limiting. It is the only option
  that makes an identity claim, so it is the only one that can be read as far
  stronger than it is. Its fail-open variant would convert a known gap into a
  false claim.
- **C** — the surviving ownership checks (`app.ts:249`, `revocation.ts:42`)
  become a trap: they still *read* as per-user enforcement while comparing a
  constant to itself. And it does not reduce the default-posture exposure at all
  — every LAN caller becomes the owner, now with no header at all.

## 7. H — recommendation

**Recommended: Option A, peer-based variant (A2) — with two conditions.**

Reasoning. The concrete harm in finding H is that *a stranger on the network
reads another human's governed run*. Only A closes that. B closes principal
choice but leaves the default posture wide open until an operator exports a
variable that the documented `.env` recipe does not actually set. C removes
principal choice while making the default posture marginally **easier** to
exploit — no header needed at all.

A is also the only option proportionate to the verified model. The audit's
conclusion is `SINGLE_OWNER_DEMO`: `Principal` has no secret field, the unlock
screen calls the token *"this shared demo token… configured by the platform
operator"*, and `apps/web` sends no `x-principal-id`. B invents a per-user
credential for an application that has no concept of a user, which is why its own
analysis returned `introducesUnnecessaryIam: true` and a 15–20× blast radius.

**Condition 1 — drop `--host 0.0.0.0` from `apps/web/package.json:7` in the same
commit.** Without it the fix is defeated by routing through the Vite dev server.

**Condition 2 — the commit must not claim to close H.** H stays open as
accepted risk with rationale. The honest sentence is: *human identity is
unauthenticated; `x-principal-id` is a selector, not a credential, and the
application is a single-owner demo.* Keep the two 401 messages distinguishable
("Authentication required" for the perimeter vs "Principal authentication
failed" for identity) so the distinction survives review.

**Separately and regardless of which option is chosen:** fix the `.env` loading
defect (§5). It is a README/tooling fix, it is independent of the identity
question, and today it silently places operators in the weakest posture while
they believe they are in the strongest.

**STOPPED FOR HUMAN APPROVAL. Nothing in §6–§7 has been implemented.**

---

## 8. Attempt #4 — final qualified wording

**This is the authoritative wording. The historical JSON was not edited.**

Attempt #4 continues to prove, from persisted evidence:

- real Container execution;
- configured live provider/model execution;
- seven completed live tasks;
- Root protected-resource denial (`NOT_EXERCISABLE_DELEGATE_ONLY`);
- a governed Identity child created by constructive delegation;
- the managed child passport crossing;
- least context;
- a bounded Return Gate;
- real provider usage;
- the configured live allowance respected;
- the observed final topology.

Attempt #4 does **not** independently preserve enough evidence to retroactively
prove the strengthened versions of:

- **complete CandidateSnapshot contents** — `candidates` arrays were never persisted;
- **the fresh-state causal WHO-change predicate** — `delegationValue`,
  `delegationThreshold` and `budget.runPressure` were never persisted;
- **decisionId cross-event correlation** — `decisionId` was never persisted.

The report persists `topology`, so the *observed* final placement per task is
genuine. What cannot be reconstructed is the *causal* story behind it.

**Where the stronger adaptive-mechanics evidence actually lives:** the
deterministic Stage 7B lifecycle and the current automated regression suite.
Those are inspectable, reproducible, and re-runnable at zero provider cost, and
they assert the full predicates — every routing decision carrying a non-empty
candidate set, the threshold/pressure/WHO-change relationship between the early
and later decisions, and decision-to-invocation correlation. The live proof
demonstrates that the governed lifecycle runs against a real container and a real
provider; the deterministic suite demonstrates *how the adaptive mechanics work*.
Those are different claims and should be presented as such.

**Budget wording.** 150,000 is an **operator-configured live integration
allowance** — a value an operator set for one external run, against which that
run's budget claims were graded. It is **not** the frozen deterministic budget
benchmark. The deterministic **12,000-token pressure benchmark** is a separate
artifact with a different purpose, and the two are not comparable demonstrations
of the same token economics.

A correction block recording this has been added to
`docs/TEAMMATE_HANDOFF_REVIEW.md` immediately after the paragraph that previously
implied only two weak oracle values existed.

---

## 9. L — documented limitation

**Return Gate read re-authorization. Decision: DOCUMENT_LIMITATION. Frozen
semantics unchanged in Stage 7D.5.**

`readArtifact` (`middleware/governance/artifacts.ts:430-451`) enforces artifact
ownership, publication state, and recipient visibility. It does **not** re-run
grant authorization on every read: it calls neither `resolveGrant` nor
`authorize`, and it appends no dedicated governed read event.

Concrete consequences, stated without overstatement:

- **Revocation** — not closed on this path. After a human revokes a grant, that
  principal's run token remains valid until its own `exp` (at most 15 minutes),
  and `GET /api/artifacts/:id` keeps returning 200 for artifact UUIDs it already
  knows and was already a recipient of. Every other agent-reachable route
  (`/api/resources/*`, `/api/tools/*`, artifact create/publish, delegations)
  closes immediately.
- **Expiry** — same bounded window, via the same run-token lifetime.
- **Budget exhaustion** — does not close this path; reads consume no budget.
- **Evidence** — artifact reads are not ledgered, so this path is invisible in
  the Governance Timeline.

**Complete mediation must not be claimed for this path.** HG-14 remains
**PARTIAL** and is not upgraded by anything in Stage 7D.5.

---

## 10. Remaining FIX_BEFORE_UI

| Item | Status |
| --- | --- |
| N — declared artifact contract on the unpublished branch | **FIXED** |
| H — human principal identity | **DECISION REQUIRED** (§6–§7) |

Everything else previously listed as FIX_BEFORE_UI was completed in
`docs/PRE_STAGE7E_HARDENING.md` §9.

**Adjacent, not blocking, but should not ship unnoticed:** the `.env`-is-never-
loaded defect (§5). It is a README/tooling fix, not an identity fix, and it
determines which posture an operator is actually in.

---

## 11. Validation

- Focused: `own-task-output-contract.test.ts` **8/8**; mutation-verified.
- Travel suite: **89/89**.
- Full suite: **416/416 across 35 files** (was 408/34 before Stage 7D.5).
- `npm run check`: PASS (typecheck, tests, server + web builds).
- `git diff --check`: PASS.

| Constraint | Result |
| --- | --- |
| External provider runs | **0** |
| Historical Attempt reports changed | **NO** |
| `apps/web` changed | **NO** |
| Router changed | **NO** |
| TaskGraph changed | **NO** |
| Authority semantics changed | **NO** |
| Budget semantics changed | **NO** |

## 12. Frozen middleware semantic impact

**One deliberate, authorised change:** `execution-engine.ts` `commitArtifacts` now
fails closed on a declared-type violation in the unpublished branch. This is a
semantic change to the execution engine — output that previously committed
silently now fails the task. It was explicitly directed as FIX_BEFORE_UI and is
an artifact-contract correctness fix, **not** an Authority change.

Unchanged, verified by `git status`: `authorize.ts`, `router.ts`, `task-graph.ts`,
`projections.ts`, `context-broker.ts`, `delegation.ts`, the gates, and the ledger.
`governed-run-view.ts` remains a pure read projection (zero matches for
`authorize`, `store.mutate`, `resolveGrant`).

No Authority, Budget, Router, TaskGraph, attenuation, or Return Gate semantics
were altered.
