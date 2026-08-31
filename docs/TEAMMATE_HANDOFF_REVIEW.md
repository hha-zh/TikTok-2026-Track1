# Teammate Handoff Review — Adaptive Agent Runtime Governor

Status: repository audit at `a6cbe897282dbcc5d12c09ee6c261641d03cbecf`
Branch: `feature/travel-lifecycle`
Audit scope: backend/runtime, workloads, evidence, reports, docs, and current Web UI
Provider executions during this audit: **0**

## 1. Executive Summary

The repository now implements an **Adaptive Agent Runtime Governor**, not only
an authorization middleware. Bouncer remains the hard governance kernel. The
runtime builds legal execution candidates from Authority Γ and Budget /
Execution Horizon B, selects WHO and HOW, executes in governed waves, records
actual outcomes and usage in the GovernanceLedger, projects new runtime state,
and rebuilds candidates for later decisions.

The implemented backend is **mostly aligned** with the frozen architecture.
The frozen middleware semantics remain internally consistent and no
Travel-specific branch or import exists in generic middleware. Stage 7D can
remain frozen: Attempt #4 plus the Stage 7D.3 offline revalidation support the
live lifecycle claims without another provider run.

The evidence model is sufficiently rich to begin UI work after teammate
review, but Stage 7E has integration/view gaps to plan explicitly:

- production startup does not inject a workload descriptor into
  `createApp()`, so ordinary `GovernedRunView` responses lack Travel labels,
  graph metadata, provenance, and workload oracles;
- there is no governed-run discovery/list endpoint, only lookup by known run ID;
- `usageFeedback.laterDecisionsReferenceProjectedState` is currently a literal
  `true`, not a correlation derived by `buildGovernedRunView()`;
- routing `explanation` is deliberately `UNAVAILABLE`, although the underlying
  decision event retains enough inputs for a future backend-owned explanation.

These are view/integration issues, not defects in authorization, routing, or
accounting semantics. They should be reviewed before UI implementation and
must not be “solved” by recomputing policy in React.

## 2. Project Identity and Core Claim

Project: **Adaptive Agent Runtime Governor**
Track: **TikTok TechJam 2026 — Track 1**

Core claim:

> Topology itself is a governed runtime variable.

Authority Γ defines where execution may legally go. Budget / Execution Horizon
B defines how far agency may expand. The adaptive runtime chooses useful
topology within both constraints:

- WHO: `REUSE_CURRENT` or `DELEGATE_SPECIALIST`
- HOW: `DIRECT`, `SERIAL`, or `PARALLEL`

Permission does not imply affordability. Affordability cannot create
permission. `estimatedTokens` is DECLARED planning evidence; actual
provider/executor usage is accounted post-hoc.

## 3. Current Git State and Checkpoints

Initial audit state was clean and synchronized:

```text
pwd:          /home/zhyjh/code/CodeJam
branch:       feature/travel-lifecycle
local HEAD:   a6cbe897282dbcc5d12c09ee6c261641d03cbecf
remote HEAD:  a6cbe897282dbcc5d12c09ee6c261641d03cbecf
working tree: clean
```

Material checkpoint history:

| Checkpoint | Material change |
| --- | --- |
| `3ee049d` Backend freeze | Reconciled Phase 6 taxonomy, evidence matrix, limitations, and frozen backend claims. It also refreshed tests/reports; it was not merely prose. |
| `63fe5af` Stage 7A | Added the Travel scenario/design contract only. No runtime implementation. |
| `e806ab7` Stage 7B | Added the deterministic Travel graph, fixtures, resource/artifact contracts, governed adapter, lifecycle runner, oracle, CLI, and tests. Generic middleware was reused unchanged. |
| `d383b6c` Stage 7C | Added the generic `GovernedRunView` builder, authenticated `GET /api/governance/runs/:id`, Travel descriptor, and view tests. |
| `9bd1b18` Stage 7D | Added the real Travel runtime adapter, live proof script/tests, and immutable Attempt #1–#4 reports. Attempt #4 is the successful live proof. |
| `a6cbe89` Stage 7D.3 | Replaced two live-oracle self-assertions with evidence-derived helpers/tests and added an offline Attempt #4 revalidation report. |

## 4. Actual Directory and Module Map

```text
apps/server/src/
├── app.ts                         Fastify routes and identity boundaries
├── agent-service.ts               Agent/message/run lifecycle and Runner calls
├── runner-factory.ts              local-process vs container selection
├── codex-runner.ts                Codex JSON event/parser and local process
├── container-codex-runner.ts      disposable container execution
├── store.ts                       serialized single-process JSON persistence
├── middleware/
│   ├── governance/
│   │   ├── authorize.ts           sole hard ALLOW/DENY primitive
│   │   ├── grant-resolver.ts      identity/grant/run/ancestry resolution
│   │   ├── delegation.ts          constructive child attenuation
│   │   ├── gates.ts               managed Resource and Trusted Tool gates
│   │   ├── artifacts.ts           create/publish/read Return Gate
│   │   ├── identity.ts            human/runtime identity verification
│   │   ├── run-token.ts           bounded in-memory runtime credentials
│   │   └── revocation.ts          grant lifecycle revocation
│   ├── adaptive/
│   │   ├── task-graph.ts          generic task/artifact/hint contract
│   │   ├── candidates.ts          CandidateSnapshot axes and eligibility
│   │   ├── execution-envelope.ts  invocation-level effective view
│   │   ├── router.ts              WHO/HOW ranking and wave packing
│   │   ├── context-broker.ts      least-context directional projection
│   │   └── execution-engine.ts    multi-round orchestration and dispatch
│   ├── evidence/
│   │   ├── ledger.ts              append + projection transaction
│   │   ├── projections.ts         RunState/GrantState derived transitions
│   │   ├── types.ts               safe correlated event contract
│   │   └── governed-run-view.ts   authenticated read-model projection
│   └── runtime/
│       └── delegated-agent-launcher.ts
│                                      child Agent/workspace/token/dispatch
└── workload/
    ├── todo/                      earlier generic reference workload/probes
    └── travel-disruption/         Stage 7 reference workload and live adapter
```

There is no single `RuntimeGovernor` facade class. `ExecutionEngine` is the
orchestration center and is composed with governance, evidence, executor, and
delegation ports by the workload/runtime integration layer.

### Actual dependency direction

```text
Travel / Todo workload
        ↓
ExecutionEngine + adaptive interfaces
        ↓
governance primitives + GovernanceLedger + JsonStore

app/runtime integration → AgentService → AgentRunner
                                     ├→ CodexRunner
                                     └→ ContainerCodexRunner
```

Generic middleware imports no Travel module. `app.ts` accepts an optional
generic `governedRunDescriptor` callback rather than importing Travel.

## 5. Runtime Call Graphs

### Ordinary request/run path

```text
HTTP message route
→ AgentService.scheduleMessage
→ AgentRun queued in JsonStore
→ AgentService.executeRun
→ configured AgentRunner.run
→ output/usage persisted
→ AgentRun completed or failed
```

The ordinary Playground path is not automatically a governed multi-task run.
`POST /api/governance/runs` creates a root principal/grant/run state, mints a
parent run token, and calls `sendGovernedMessage()` for one bounded governed
Agent turn.

### Governed multi-task path

```text
TaskGraph + root identity
→ ExecutionEngine.run
→ resolve latest GrantState/RunState
→ readyNodes
→ one CandidateSnapshot for the round
→ buildCandidates
     ├→ authorize() hard capacity/scope verdicts
     ├→ deriveChildEnvelope() delegation feasibility preview
     └→ AuthorityView + BudgetView
→ hardEligible + planningFit → routableNow
→ route() WHO/HOW + ordered waves
→ Ledger routing_decision
→ per-wave Promise.all(dispatch)
→ fresh grant resolution + ExecutionEnvelope + ContextBroker
→ workload executor / delegated launcher
→ actual usage → tokens_consumed
→ Ledger atomically applies projections
→ artifact commit + task outcome
→ next round resolves fresh projected state
```

`ExecutionEngine` owns scheduling, deferral ceilings, wave execution,
decision/invocation correlation, task progress, and artifact admission. It does
not own authority policy, provider execution, domain semantics, artifact
schema policy, or usage generation.

### Container / Codex / Ark path

```text
Travel live executor
→ AgentService.sendGovernedMessage
→ AgentService.executeRun
→ runner-factory: RUNTIME_PROVIDER=container
→ ContainerCodexRunner
→ container engine run --rm ... codex exec --json
→ generated Codex config: model_provider=volcengine_ark
→ Volcengine Ark Responses API
→ Codex turn.completed usage
→ AgentRun.usage
```

The label `LIVE_CONTAINER_CODEX_ARK` is DECLARED provenance supported by this
configured path, completed live runs, and provider-reported usage. It is not a
cryptographic provider attestation.

### Protected Resource Gate

```text
RUN_TOKEN → verifyIdentity
→ principalId + grantId + runId
→ readManagedResource(identity, resourceId)
→ resolveGrant and ancestry
→ authorize(principal, "read", resourceId, state)
→ resource_allowed or resource_denied Ledger event
→ body returned only on ALLOW
```

The gate owns the mediated backend read and its evidence. It does not own task
completion or decide what derived facts a model should receive.

### Delegated child creation

```text
Router chooses DELEGATE_SPECIALIST
→ ExecutionEngine calls DelegationPort
→ DelegatedAgentLauncher.prepare
→ DelegationService.delegate
→ authorize("delegate")
→ deriveChildEnvelope(parent, request)
→ persist child Principal + Envelope
→ grant_created / principal_created
→ create child Agent/workspace
→ mint child RUN_TOKEN
→ derive invocation envelope + project context
→ DelegatedAgentLauncher.dispatch
→ AgentService.sendGovernedMessage(child)
```

`deriveChildEnvelope()` owns constructive attenuation. The launcher owns the
runtime child Agent/token bridge. Neither chooses topology.

### ContextBroker

```text
committed run artifacts + TaskSpec.requiredArtifacts
+ executor identity/ancestry + invocation ExecutionEnvelope
→ projectContext
→ included + withheld(reason) + missingRequired
→ context_projected event
→ dispatch only if missingRequired is empty
```

Own task output flows to its producer and descendants. It does not flow upward.
Published findings flow only to named recipients. The broker owns information
projection, not authorization, memory, transcripts, or protected-resource
loading.

### Return Gate

```text
child identity
→ createArtifact: authorize artifact:create
→ private stored artifact + artifact_created
→ publishArtifact: re-resolve ancestry + authorize artifact:publish
→ schema/field validation
→ recipient restricted to publisher ancestry (default parent)
→ artifact_published
→ parent readArtifact only if published and named recipient
→ ExecutionEngine verifies stored owner/type/publication before commit
```

It owns bounded upward declassification and recipient/schema controls. It does
not accept raw assistant output as a parent handoff.

### Ledger feedback and read model

```text
executor-reported usage
→ ExecutionEngine append tokens_consumed
→ GovernanceLedger serialized append
→ applyGovernanceEvent in same store mutation
→ RunState.tokensUsed + GrantState.tokensUsed
→ next round resolveGrant
→ fresh CandidateSnapshot / threshold / WHO

GET /api/governance/runs/:id
→ human identity + owner check
→ buildGovernedRunView(store, runId, optional descriptor)
→ safe events, tasks, routing, authority, horizon, delegation,
  context, bounded artifacts, usage, outcome/oracles
```

The Ledger is the sole append-only governance evidence and event-driven
projection-update path. The whole `JsonStore` is not event-sourced.

## 6. Component Ownership Summary

| Component | Inputs → outputs | Owns | Explicitly does not own |
| --- | --- | --- | --- |
| `authorize()` | principal/action/resource/resolved state → verdict/reason | only hard ALLOW/DENY verdict | routing, context, child construction |
| `deriveChildEnvelope()` | parent + request + construction → attenuated child envelope/failure | constructive subset/bounds | runtime Agent creation or dispatch |
| CandidateBuilder | task + current state → two annotated candidates | explanatory Authority/Budget axes and eligibility | new policy verdicts or topology choice |
| Router | exact candidate snapshot + horizon + hints → assignments/waves | WHO/HOW ranking and scheduling plan | authority creation, provider execution |
| ExecutionEnvelope | grant/task/policy intersection → invocation view | per-task narrowing and budget view | authority source or verdict |
| ExecutionEngine | graph + identity + ports → correlated run result | rounds, waves, fresh state, dispatch, task outcomes | domain logic, runner, gate policy |
| ContextBroker | task/envelope/artifacts/ancestry → projected context | least-context directionality | authorization or protected resource reads |
| Resource/Tool Gates | identity + requested crossing → gated result/event | managed crossing mediation | arbitrary filesystem/network activity |
| Return Gate | child artifact + schema/recipients → bounded visible artifact | explicit upward handoff | raw child prose or covert-channel elimination |
| GovernanceLedger | typed event/context → appended event + projection | evidence ordering, sanitization, projection transaction | full application persistence |
| AgentService | Agent/prompt/context → AgentRun lifecycle | queue, runner call, run/message persistence | adaptive topology or authority |
| AgentRunner | RunnerRequest → output/thread/usage | process/container interaction | trusting or interpreting domain output |
| Workload adapter | task request → domain artifact/usage | required crossings and semantic validation | generic middleware semantics |
| GovernedRunView | store/run/descriptor → safe read model | backend explanation projection | recomputing policy or raw transcripts |

## 7. Authority × Budget/Horizon and Adaptive WHO/HOW

The architecture remains balanced despite the recent Passport-heavy proof
work:

- Authority complexity is larger because identity, grants, ancestry,
  attenuation, gates, revocation, and declassification require more code.
- Budget remains a peer decision axis in CandidateBuilder and `authorize()`.
- Router thresholds depend on current run pressure; declared task value remains
  intrinsic rather than changing with remaining budget.
- `ExecutionEngine` reloads projected state at every round.
- Actual usage, not estimates, updates `RunState` and `GrantState`.

The deterministic Travel evidence genuinely demonstrates:

| Moment | Observed topology |
| --- | --- |
| T0 | `REUSE_CURRENT + DIRECT` |
| T1/T2 | `DELEGATE_SPECIALIST + PARALLEL` |
| T3 | `REUSE_CURRENT + DIRECT` |
| T4 | `DELEGATE_SPECIALIST + DIRECT` |
| T5/T6 | fresh later decisions, `REUSE_CURRENT + DIRECT` |

This topology is not encoded as a result field in `TaskGraph`. The graph
declares resources, actions, dependencies, artifact contracts, estimates, and
soft hints. The router computes topology from the current candidate snapshot.

The repository has an **implementation-complexity and presentation emphasis**
toward Authority, not an architectural collapse into Bouncer. Stage 7E should
visually restore the balance between Authority Γ, Horizon B, routing, and
feedback rather than centering only T4.

## 8. Travel Reference Workload and Domain Independence

Travel remains downstream of generic middleware:

```text
travel-disruption/* imports middleware/*
middleware/* imports no travel-disruption module
```

Searches for `travel`, `passport`, `flight`, `hotel`, `Tokyo`, and
`IdentityVerification` found no domain-specific semantic branch in generic
middleware. There is no Travel policy in `authorize()`, no Travel formula in
the Router, and no Travel branch in `ExecutionEngine`.

The generic `GovernedRunView` knows only a supplied workload descriptor and
typed events. Travel constructs that descriptor in the workload package. This
is dependency injection, not a generic-to-domain import.

## 9. Stage 7D.2 Required Crossing Repair

The T4 repair is a **task/runtime execution contract**, not a second
authorization layer.

The live Travel adapter:

1. locates the actual T4 child and persisted child principal;
2. constructs identity using the actual child principal, child grant, and run;
3. calls the existing `readManagedResource()` Resource Gate;
4. fails T4 if the read is denied;
5. independently requires a matching `resource_allowed` event for child
   principal, child grant, passport resource, and read action;
6. derives non-sensitive verification checks in the trusted child-local
   adapter;
7. gives only those safe checks to the real model;
8. requires schema-valid publication and exact semantic agreement with the
   derived checks;
9. returns the result through the generic Return Gate.

Raw passport data does not enter the root context, workspace, Ledger, proof
report, artifact, or model prompt. The model does **not** read the raw passport.
The delegated child-scoped runtime exercises the protected resource; the model
receives derived safe facts.

Conceptually, the same pattern could support incident response, coding/test
execution, finance verification, or production operations: require a real
managed crossing under the executing principal, transform sensitive input in a
trusted local adapter, give the model minimal derived facts, and publish a
bounded typed result. Those workloads are not claimed as implemented.

## 10. Attempt #1–#4 and Robustness Evolution

| Attempt | Result | What it proved or exposed |
| --- | --- | --- |
| #1 | FAILED at T0 | Container, Ark/model path, root passport denial, and 28,740 observed tokens; exposed unbounded live output contract. |
| #2 | 7/7 tasks, overall FAILED | 125,053 used against 120,000. The final in-flight call caused post-hoc overshoot; no later dispatch followed exhaustion. Frozen accounting behaved correctly. |
| #3 | 7/7 and budget PASS, overall FAILED | 115,801/150,000, but no observed child passport read. A valid-looking artifact was insufficient; oracle failed closed. |
| #4 | PROVEN | 7 runs, no retries, mandatory child crossing, bounded artifact, 116,174/150,000, revocation, isolation, and all oracles/claims passed. |

The deterministic 12,000-token benchmark and live 150,000-token allowance have
different purposes and pressure. They are not comparable demonstrations of the
same token economics.

Stage 7D.3 removed the live proof's two literal oracle successes:
`noRawChildHandoff` now requires parent-view raw-output absence plus successful
bounded Return Gate evidence; `earlyRouterTopology` now requires persisted T1
and T2 `DELEGATE_SPECIALIST + PARALLEL` routing evidence. The offline
revalidation reports PASS for both, PASS for the reconstructed oracle, zero
provider calls, and an unchanged Attempt #4 SHA-256.

## 11. Evidence Quality

| Quality | Meaning here | Examples |
| --- | --- | --- |
| OBSERVED | Captured from a real crossing/runtime result | Ledger `resource_allowed`, runner usage, HTTP Return Gate result, completed AgentRun |
| DERIVED | Computed from observed/persisted state | budget remaining, pressure, attenuation diff, oracle aggregation, projected tokens used |
| DECLARED | Author/configuration input, not runtime measurement | estimates, hints, task graph, `LIVE_CONTAINER_CODEX_ARK` label |
| DETERMINISTIC | Reproducible fixture execution | Stage 7B 12k lifecycle and topology adaptation |
| LIVE | Real container/Codex/configured provider lifecycle | Stage 7D reports and provider usage |
| UNAVAILABLE | Not supported by evidence contract | GovernedRunView routing explanation text |

Final Attempt #4 confidence:

| Claim | Status / quality |
| --- | --- |
| Container execution | PROVEN by configured concrete runner path and completed runs |
| Provider/model | Strongly supported LIVE evidence; provenance label remains DECLARED, non-cryptographic |
| Root passport denial | PROVEN, OBSERVED `DENY/NOT_EXERCISABLE_DELEGATE_ONLY` |
| Governed child and attenuation | PROVEN from persisted principals/grants/envelopes/events |
| Child passport crossing | PROVEN by mandatory gate call and correlated OBSERVED allow event |
| Least context | PROVEN from context projection evidence |
| Return Gate | PROVEN by create/publish/recipient/read evidence |
| Usage/accounting | OBSERVED runner usage → Ledger; projected total DERIVED |
| Budget respected | DERIVED 116,174 ≤ 150,000 |
| Normal-state isolation | PROVEN byte comparison in isolated proof |
| Secret/protected resource audit | PASS over sanitized captured flows |
| Oracle derivation | Revalidated PASS offline at Stage 7D.3 |

The isolated proof state was normally cleaned, and the report does not preserve
raw Codex JSON events or a provider-signed receipt. Therefore the live provider
claim is not independently cryptographically attestable from the report alone.

## 12. Intended vs Implemented Matrix

| Area | Intended design | Implemented reality | Alignment | Deviation | Severity | Recommended action |
| --- | --- | --- | --- | --- | --- | --- |
| Run boundary | Correlated governed run | runId on grants, tokens, events, state, view | ALIGNED | Ordinary Playground remains separate/ungoverned | None | Preserve distinction |
| Authority source | Principal Grant/Envelope | resolved persisted Envelope + ancestry | ALIGNED | None | None | Freeze |
| `authorize()` uniqueness | sole hard verdict | all managed gates/delegation/candidates call it | ALIGNED | Artifact schema validation is content validation, not authority | None | Freeze |
| Child attenuation | only constructive derivation | `deriveChildEnvelope()` + branded result; service persists it | ALIGNED | CandidateBuilder performs a discarded feasibility derivation | None | Freeze |
| ExecutionEnvelope | invocation-level view | fresh intersection before dispatch | ALIGNED | Re-derived after child creation, correctly not authority | None | Freeze |
| Budget/Horizon | peer to authority, post-hoc | stored caps/usage, hard capacity and planning fit separated | ALIGNED | in-flight overshoot and trusted usage | Frozen limitation | Document |
| CandidateSnapshot | exact once-per-round snapshot | same objects routed and recorded | ALIGNED | None | None | Freeze |
| eligibility | hardEligible/planningFit/routableNow | explicitly computed and persisted in routing evidence | ALIGNED | None | None | Freeze |
| Adaptive WHO/HOW | useful topology in legal space | threshold-based WHO and ordered wave HOW | ALIGNED | heuristic, not global optimizer | Intended | Explain honestly |
| Engine ownership | orchestration, not policy | rounds/waves/dispatch/progress/artifact admission | ALIGNED | no single facade class | Low | No change required |
| ContextBroker | least-context, directional | required/visible artifacts only, fail closed on missing | ALIGNED | no general memory/transcript system | Intended | Freeze |
| Mandatory crossing | workload execution contract | T4 live adapter requires real Gate + matching event | ALIGNED | Travel-specific completion contract, appropriately downstream | None | Preserve pattern |
| Return Gate | bounded upward flow | create/publish/schema/ancestry recipient/read + engine verification | ALIGNED | covert channels not eliminated | Frozen limitation | Document |
| GovernanceLedger | append-only evidence + projections | serialized append and projection in one mutation | ALIGNED | application state also mutates directly | Intended | Do not call fully event-sourced |
| Runtime feedback | actual usage affects later decisions | tokens event updates state; next round reloads it | ALIGNED | view contains one un-derived correlation boolean | Medium view issue | Derive or remove before relying on UI claim |
| Provenance | explicit evidence quality | view marks execution provenance DECLARED | ALIGNED | no provider attestation | Intended limitation | Preserve wording |
| GovernedRunView | backend truth for UI | rich safe read model and owner-gated API | MOSTLY_ALIGNED | production lacks descriptor wiring/run discovery; explanation unavailable | Medium | Stage 7E integration review |
| Deterministic vs live | separate evidence roles | separate adapters/reports/caps | ALIGNED | live cost/variance high | Operational | Keep separate |
| Protected boundary | backend-only raw passport | resource body stays in trusted local adapter | ALIGNED | danger-full-access cannot support universal mediation claim | High if overclaimed | Bound claims |
| Child lifecycle | temporary grants terminal | Travel runners explicitly revoke grants | MOSTLY_ALIGNED | cleanup is workload orchestration, not automatic Governor primitive; Agents are not universally deleted | Medium | Display grant lifecycle accurately |
| Complete mediation | managed crossings only | resources/tools/delegation/artifacts and dispatch budget mediated | INTENTIONAL_LIMITATION | model subcalls and arbitrary FS/network not intercepted | Frozen limitation | Keep HG-14 PARTIAL |
| `maxToolCalls` | metadata only | attenuated and exposed as `enforced:false` | INTENTIONAL_LIMITATION | no counter/enforcement | None under frozen scope | Do not claim enforcement |

Overall alignment: **MOSTLY**. Deviations are primarily read-model wiring,
proof tooling safety, and documented POC limitations—not middleware drift.

## 13. Completion Matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Hard Governance Kernel | COMPLETE | `authorize.ts`, resolver/gate tests, Phase 6 evidence |
| Identity / grants | COMPLETE | identity, run-token, resolver, fixture tests |
| Constructive delegation | COMPLETE | `deriveChildEnvelope`, `DelegationService`, tests |
| Resource Gate | COMPLETE | `gates.ts`, gate tests, live T4 event |
| Model/budget mediation | PARTIAL | dispatch blocking/accounting complete; per-provider-call proxy intentionally absent |
| Return Gate | COMPLETE | artifact implementation/tests and live parent retrieval |
| Schema/recipient controls | COMPLETE | artifact schema and ancestry-recipient tests |
| ContextBroker | COMPLETE | directionality/least-context tests and Travel proof |
| ExecutionEngine | COMPLETE | scheduling/correlation/defer/artifact tests |
| Adaptive Router | COMPLETE | policy and adaptive tests; deterministic topology evidence |
| CandidateSnapshot | COMPLETE | exact snapshot event contract and tests |
| Budget feedback | COMPLETE | Ledger/projection/feedback-loop tests |
| Deterministic Travel lifecycle | COMPLETE | Travel lifecycle/oracle tests |
| Live Travel lifecycle | COMPLETE | Attempt #4 PROVEN |
| GovernedRunView contract | COMPLETE | generic builder/API/tests |
| GovernedRunView production integration | PARTIAL | descriptor/listing gaps described above |
| Automated tests | COMPLETE for frozen backend | 376/376 baseline at this commit |
| External proof | COMPLETE | Attempt #4 + revalidation |
| Frontend Run Inspector | NOT STARTED | current UI is Agent Playground only |
| README/submission docs | PARTIAL | README updated broadly; final project/submission wording pending |
| Final architecture diagram | PARTIAL | technical docs have diagrams; submission-quality diagram pending |
| 3-minute demo rehearsal/recording | NOT STARTED | no repository evidence |
| Final acceptance audit | NOT STARTED | follows UI/docs/demo |

Approximate grouped completion: backend/governance/runtime **high and frozen**;
evidence contract **high with minor integration gaps**; frontend **not
started**; submission documentation/demo **early-to-partial**. A single overall
percentage would imply false precision.

## 14. Test and Verification Inventory

Verified baseline at the current commit:

- focused Stage 7D.3 evidence tests: 10/10;
- all Travel tests: 63/63 across 4 files;
- full server suite: 376/376 across 33 files;
- `npm run check`: PASS (server/web typecheck, tests, server/web builds);
- `git diff --check`: PASS;
- Stage 7D.3 external provider runs: 0.

| Claim | Automated or persisted evidence |
| --- | --- |
| Hard Governance | authorize/resolver/delegation/revocation/gate tests; Phase 6 matrix |
| Adaptive Runtime | adaptive/router/engine/feedback-loop tests; deterministic Travel oracle |
| Least context | ContextBroker tests; Travel view/live-runtime tests |
| Return Gate | artifact tests, engine artifact-admission tests, Travel live tests |
| Budget | authority-budget, projections, feedback loop, execution engine tests |
| Travel lifecycle | deterministic lifecycle and oracle tests |
| Live proof | immutable Attempt reports; live adapter tests use controlled substitutes where appropriate |
| Evidence oracle | Stage 7D.3 focused tests and offline revalidation |
| Secret hygiene | proof-script flow scan and committed Attempt #4 secret audit |

Important claims not reproduced by ordinary automated CI:

- a new real Ark/container lifecycle (intentionally not rerun; Attempt #4 is
  historical evidence);
- provider identity beyond configured path and reported usage;
- container isolation against a hostile multi-tenant adversary;
- browser UX, responsive layout, and final demo narrative;
- covert-channel resistance;
- real-world airline/hotel/payment behavior, intentionally absent.

## 15. Known Limitations

1. Token accounting is post-hoc; one already-dispatched call per principal may
   overshoot before usage is known.
2. There is no provider token reservation or hard provider-side token cap in
   `estimatedTokens`.
3. `maxToolCalls` is metadata and is not enforced.
4. Complete mediation is bounded to Bouncer-managed crossings. HG-14 remains
   PARTIAL.
5. A model may perform multiple internal provider calls inside one dispatch;
   only returned aggregate usage is trusted and accounted.
6. `danger-full-access` and arbitrary filesystem/network access sit outside the
   strongest governance claim. Protected resources must remain backend-only.
7. Revocation blocks later governed crossings/publication but cannot undo an
   already-completed external side effect.
8. The Return Gate reduces explicit information flow but does not eliminate
   covert channels.
9. `JsonStore` is single-process JSON persistence, not a transactional
   multi-node store and not a fully event-sourced system.
10. Run tokens are in-memory operational credentials; restart/recovery and
    distributed verification are POC-grade.
11. Live provenance is not cryptographic attestation.
12. Real provider usage is expensive and variable. The live 150k allowance is
    not equivalent to the deterministic 12k pressure benchmark.
13. The model receives derived passport verification checks, not the raw
    passport. Claims must describe that exact flow.
14. Real airline, hotel, booking, payment, and approval execution are
    intentionally outside the demo.
15. Automatic success-path child cleanup is not a generic Governor primitive;
    Travel explicitly revokes temporary grants.
16. Production `GovernedRunView` descriptor wiring and run discovery are
    incomplete for a polished inspector.

## 16. Architecture Drift and Technical Debt Audit

### Frozen middleware

No concrete defect was found in the frozen authority, attenuation, candidate,
router, scheduling, envelope, ContextBroker, Return Gate, or Ledger semantics.
No Travel dependency violation was found.

### Findings for teammate review — do not fix during this audit

| File / function | Severity | Finding | Why it matters | Recommended review action |
| --- | --- | --- | --- | --- |
| `middleware/evidence/governed-run-view.ts` / `buildGovernedRunView` | MEDIUM | `usageFeedback.laterDecisionsReferenceProjectedState` is literal `true`. | UI could display an evidence claim that the view did not itself derive. Deterministic tests prove the architecture, but this field is not run-specific evidence. | Before using it in Stage 7E, derive correlation from ordered usage/routing events or mark it unavailable. |
| `index.ts` / `createApp` composition | MEDIUM | Production startup does not provide `governedRunDescriptor`. | API responses can infer task IDs but lose workload labels, graph dependencies/types, provenance, and oracles. | Decide a backend-owned descriptor registry/read-model source for Stage 7E. Do not reconstruct in React. |
| `app.ts` governed-run API | MEDIUM | Only `GET /api/governance/runs/:id`; no owner-scoped list/discovery endpoint. | Inspector needs a known run ID or another selection mechanism. | Confirm demo uses a fixed known run ID or add a minimal read-only listing contract in the Stage 7E plan. |
| `governed-run-view.ts` routing decisions | LOW/MEDIUM | `explanation` is always `UNAVAILABLE`; candidate view omits some persisted details such as effective scopes and budget reason. | Runtime Decision Card and authority-versus-budget explanation may be thinner than desired. | Prefer backend projection of persisted event facts; never rerun Router logic in UI. |
| `scripts/stage7d-travel-proof.mjs` / `reportPath` | HIGH tooling risk | Script still writes the fixed Attempt #4 path despite the comment requiring a distinct report for each authorized run. | An accidental rerun can overwrite immutable successful historical evidence, especially with the 120k default cap. | Keep Stage 7D frozen and do not rerun. Before any future live attempt, require an explicit new output path as a separate reviewed task. |
| `apps/server/package.json` description | LOW | Still says “middleware-free Agent platform starter kit.” | Stale package metadata understates the Governor. | Correct during final documentation/submission cleanup, not backend freeze. |
| `docs/TRAVEL_LIFECYCLE.md` status line | LOW | Still labels itself Stage 7A design contract and uses future-stage wording. | Historically accurate but easy for a newcomer to misread as current status. | Add a historical-status note during docs cleanup; do not rewrite the contract. |
| `BACKLOG.md` | LOW | Says README still describes a middleware-free starter kit, while README has since been updated. | Stale backlog statement creates handoff confusion. | Reconcile during final documentation pass. |

The high tooling risk does not invalidate Attempt #4 or require a middleware
change. It is a reason to preserve the freeze and avoid another live run.

## 17. Teammate Review Checklist

Use source and evidence to answer each item independently:

- [ ] Is `authorize()` still the only hard ALLOW/DENY source?
- [ ] Can a persisted child Envelope be constructed outside
      `deriveChildEnvelope()`?
- [ ] Does the Travel graph declare inputs/hints rather than final topology?
- [ ] Does any generic middleware import or branch on Travel semantics?
- [ ] Is the protected passport ever mounted or copied into a workspace?
- [ ] Does Root receive `NOT_EXERCISABLE_DELEGATE_ONLY` for passport read?
- [ ] Can the attenuated Identity child exercise passport read?
- [ ] Does T4 require the actual child/grant/run `resource_allowed` crossing?
- [ ] Can parent ContextBroker visibility admit raw child task output?
- [ ] Does Return Gate enforce owner, authorization, schema, ancestry recipient,
      publication, and read visibility?
- [ ] Does runner usage reach `tokens_consumed` and projections?
- [ ] Does each engine round resolve fresh state before CandidateSnapshot?
- [ ] Are deterministic 12k and live 150k budgets presented separately?
- [ ] Does the UI consume `GovernedRunView` without recomputing policy?
- [ ] Are stale package/backlog/Travel status statements understood as docs
      debt rather than architecture truth?
- [ ] Is the fixed Attempt #4 proof output protected from accidental rerun?
- [ ] Is the literal `laterDecisionsReferenceProjectedState` addressed or hidden
      before the UI treats it as evidence?

## 18. Stage 7E Readiness

The backend evidence contract is stable enough to begin Stage 7E **after this
review**, with the view-layer gaps above explicitly resolved in the plan.

| UI component | Readiness | Current API support / gap |
| --- | --- | --- |
| Run Header | READY_FROM_CURRENT_API | run ID, workload when descriptor exists, status, timestamps, duration, root |
| Lifecycle / Task Graph | MINOR_BACKEND_VIEW_GAP | tasks/dependencies/status exist with descriptor; production descriptor is not wired |
| Runtime Decision Card | MINOR_BACKEND_VIEW_GAP | WHO/HOW/candidates/horizon exist; explanation is unavailable and some candidate evidence is omitted |
| Delegation Tree | READY_FROM_CURRENT_API | parent/child IDs, task correlation, lifecycle, attenuation |
| Governance Timeline | READY_FROM_CURRENT_API | safe normalized correlated events |
| Authority × Budget/Horizon | READY_FROM_CURRENT_API | root authority, caps/usage/remaining, children, depth, maxToolCalls enforcement truth |
| Parent → Child attenuation diff | READY_FROM_CURRENT_API | retained/removed resources/actions and child delegation flag |
| Context included/withheld | READY_FROM_CURRENT_API | per-invocation included IDs and typed withheld reasons |
| Return Gate visualization | READY_FROM_CURRENT_API | visible bounded artifact lifecycle/recipients/fields and events |
| Usage feedback → later routing | MINOR_BACKEND_VIEW_GAP | deltas and later routing snapshots exist, but the correlation flag is self-asserted and explanation absent |
| Run selection/discovery | NOT_READY | no owner-scoped governed-run list; only lookup by known run ID |

Stage 7E rules:

- read-only UI;
- backend is truth, UI is explanation;
- runtime-created children live under the run/delegation tree, not “YOUR
  AGENTS”;
- do not calculate authoritative remaining budget, attenuation, policy, or
  routing reasons in the browser;
- do not expose messages, raw child output, credentials, or protected contents;
- keep Authority Γ and Horizon B visually balanced.

## 19. Remaining Roadmap

```text
Teammate review
→ Stage 7E Run Inspector UI
→ UI integration and manual browser verification
→ README/submission wording + final architecture diagram
→ reproducibility command
→ 3-minute demo script
→ demo recording/screenshots
→ final secret hygiene audit
→ submission acceptance checklist
→ final freeze
```

Remaining coding work:

- Stage 7E frontend;
- likely small backend read-model integration fixes for descriptor wiring, run
  selection, and evidence-derived usage-to-routing explanation;
- browser integration/accessibility/responsive fixes discovered during manual
  verification.

Remaining non-coding work:

- teammate sign-off;
- README/package/backlog/status cleanup and selected Track 1 wording;
- submission-quality architecture diagram;
- reproducibility instructions that do not require another expensive live run;
- 3-minute demo script, rehearsal, recording, and screenshots;
- final secret hygiene and acceptance audits.

Stage 7E remains the last **planned major** coding phase. Small integration
fixes are realistic and should not be mislabeled as a new architecture phase.

## 20. Handoff Verdict

```text
TEAMMATE HANDOFF AUDIT:                         COMPLETE
CURRENT ARCHITECTURE MATCHES FROZEN DESIGN:    MOSTLY
GENERIC MIDDLEWARE REMAINS DOMAIN-INDEPENDENT: YES
STAGE 7D REMAINS FREEZABLE:                    YES
BACKEND READY FOR TEAMMATE REVIEW:             YES
BACKEND READY FOR STAGE 7E AFTER REVIEW:       YES
STAGE 7E IS LAST PLANNED MAJOR CODING PHASE:   YES
READY FOR HUMAN REVIEW:                        YES
```
