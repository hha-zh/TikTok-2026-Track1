# Travel Disruption Companion — Lifecycle Contract

Status: Stage 7A design contract for deterministic Stage 7B implementation.
Backend baseline: Phase 6D.1 at `3ee049d`.

## Contract boundary

The user scenario is:

> My flight from Singapore to Tokyo tonight has been cancelled. I need to
> arrive in Tokyo before 1 PM tomorrow. Re-plan the trip, keep additional
> travel cost below SGD 700, and flag any booking above SGD 300 for my
> approval.

The Travel workload owns the problem definition: tasks, dependencies,
resources, domain rules, bounded artifact types, declared routing hints,
deterministic fixtures, ground truth, and success oracle.

The frozen Governor owns execution: authorization, hard eligibility,
Budget/Execution Horizon, REUSE versus DELEGATE, DIRECT/SERIAL/PARALLEL,
attenuation, context projection, Return Gate publication, usage feedback, and
runtime topology. No Travel code may select an Agent topology directly.

```text
WORKLOAD DEFINES THE PROBLEM.
GOVERNOR DECIDES THE EXECUTION TOPOLOGY.
```

## Two separate kinds of constraint

Domain constraints determine whether a proposed journey solves the user's
problem:

- arrival in Tokyo strictly no later than 13:00 Asia/Tokyo on fixture day 2;
- total additional travel spend no greater than SGD 700;
- each proposed booking above SGD 300 sets `approval_required`;
- no booking or payment is executed by this lifecycle.

The SGD limit and approval threshold are not Governor budgets. In Stage 7B,
they are ordinary bounded domain values evaluated by the workload oracle.
`approval_required` is a result flag for the user; it does not introduce a new
human-in-the-loop policy engine or pause the Governor.

Runtime constraints bound how far agency may expand:

- shared run token cap;
- per-grant token cap;
- `maxChildren`;
- delegation depth;
- parallel capacity;
- post-hoc actual usage projected from `tokens_consumed` events.

`maxToolCalls` remains metadata and is not enforced. Domain spend must never be
converted to tokens, and runtime token pressure must never change the SGD
correctness oracle.

## Frozen architecture

Authority Γ and Budget / Execution Horizon B are parallel constraint
dimensions. They jointly define the admissible runtime space. Adaptive routing
chooses WHO and HOW inside that space.

```text
Authority Γ --------------------\
                                 > admissible runtime space
Budget / Execution Horizon B ---/              |
                                                v
                                      Adaptive WHO / HOW
                                                |
                                                v
                                            Execution
                                                |
                                                v
                                         Runtime outcomes
                                                |
                                                v
                                         Projected state
                                                |
                                                v
                                          Next decision
```

The GovernanceLedger is cross-cutting. It records identity and grant lifecycle,
hard decisions, CandidateSnapshots and routing, context projection, resource
access, delegation, invocation, artifact/Return Gate activity, usage, and
task/run outcomes. It is not merely an execution log.

The decision pipeline remains:

```text
Task -> CandidateSnapshot -> AuthorityView + BudgetView
  -> hardEligible + planningFit -> routableNow
  -> Adaptive Router -> WHO + HOW -> dispatch
```

## Lifecycle

1. **Start.** A human starts a governed Travel run. The root Travel Agent gets
   a run-bound root grant and token. Deterministic Travel resources and bounded
   artifact schemas are already registered.
2. **Triage.** `T0 understand_disruption` reads the exercisable itinerary,
   calendar, and preferences, rejects the cancelled original flight, and
   commits `travel_constraints`. The authority shape and absent benefit of
   extra agency should naturally yield REUSE_CURRENT + DIRECT.
3. **Explore alternatives.** `T1 search_transport` and
   `T2 search_accommodation` consume the constraints. They are genuinely
   independent and have declared specialist value, so healthy runtime state
   may yield delegated parallel exploration. That result is a Router decision,
   not a workload instruction.
4. **Sensitive boundary.** The root attempts the synthetic passport read
   through the real Resource Gate. Because the same resource is delegatable but
   not exercisable, the frozen `authorize()` contract truthfully returns HTTP
   403 `NOT_EXERCISABLE_DELEGATE_ONLY` and records the real denial. Passport
   content must not reach the root. The denial is expected and recoverable.
5. **Governed delegation.** `T4 verify_identity` requires authority the root may
   cause but not exercise. CandidateBuilder must therefore make REUSE illegal
   and a narrowly derived child legal, subject to current horizon capacity.
6. **Least context.** ContextBroker gives the Identity Specialist only the
   bounded booking/traveler name, destination, document-validity requirement,
   and task instruction. It receives no general transcript or unrelated
   Travel artifacts.
7. **Return Gate.** The child reads `identity/passport` through the backend and
   publishes only `IdentityVerification` to the root. Raw passport data and raw
   child output cannot be the parent handoff.
8. **Adapt from history.** Actual executor usage appends `tokens_consumed` to
   the Ledger. RunState and GrantState projections feed later
   CandidateSnapshots. No fixture directly mutates `tokensUsed`.
9. **Validate and synthesize.** `T5 validate_recovery_plan` is legal under both
   placements where capacity permits. Earlier usage may raise the delegation
   threshold so the frozen Router later prefers reduced agency. `T6
   final_recovery_plan` consumes only permitted bounded artifacts and produces
   the final user-facing plan.
10. **Complete and close.** Required tasks and artifacts settle, the run outcome
    is recorded, child authority is revoked, and temporary child Agents are
    stopped/deleted through existing application lifecycle operations. Cleanup
    must not fabricate a Governor event or introduce a new policy primitive.
11. **Audit.** Correlated Ledger evidence reconstructs the hard denial,
    recovery, candidates, decisions, attenuation, context withholding, Return
    Gate, usage feedback, and outcome without storing protected content.

## TaskGraph contract

Names follow the existing `TaskSpec` convention: stable snake-case IDs,
artifact dependencies distinct from ordering dependencies, planning estimates
that are never accounting, and hints explicitly labeled as declared.

| ID | Task | Needs | Produces | Routing intent, never a topology command |
| --- | --- | --- | --- | --- |
| T0 | `understand_disruption` | itinerary, calendar, preferences | `travel_constraints` (`TravelConstraints`) | Input resources are root-exercisable but not child-delegatable; expected REUSE_CURRENT + DIRECT. |
| T1 | `search_transport` | `travel_constraints`, deterministic transport inventory | `transport_options` (`TransportOptions`) | Both placements legal; independent of T2; declared specialist utility/cost. |
| T2 | `search_accommodation` | `travel_constraints`, deterministic accommodation inventory | `accommodation_options` (`AccommodationOptions`) | Both placements legal; independent of T1; declared specialist utility/cost. |
| T3 | `plan_local_arrival` | `transport_options`, route inventory | `route_plan` (`RoutePlan`) | Depends on relevant transport evidence; not declared independent of its producer. |
| T4 | `verify_identity` | viable transport context, protected passport | `identity_verification` (`IdentityVerification`) | Root cannot exercise passport read; bounded delegated identity authority is the only legal placement. |
| T5 | `validate_recovery_plan` | constraints, transport, accommodation, route, identity verification | `validated_recovery_plan` (`ValidatedRecoveryPlan`) | Resource-free bounded reasoning after inputs arrive; both placements legal and softly ranked. |
| T6 | `final_recovery_plan` | constraints and validated recovery plan | `final_travel_recovery_plan` (`FinalTravelRecoveryPlan`) | Root-facing synthesis with no declared benefit to extra agency; expected reuse under defaults, not forced. |

### Dependency shape

```text
T0 understand_disruption
        |
        +----------------------+
        |                      |
T1 search_transport    T2 search_accommodation
        |
T3 plan_local_arrival
        |
        +----------- T4 verify_identity
        |                      |
        +----------+-----------+
                   |
          T5 validate_recovery_plan
                   |
          T6 final_recovery_plan
```

T4 may start only after a viable transport option exists. T5 requires actual
committed artifacts, not merely completed or skipped producer statuses. T1 and
T2 may share a parallel wave only when the frozen Router finds distinct
executors, independence, headroom, and child capacity.

Suggested Stage 7B hints for T1/T2 and T5 should be fixed deterministic fixture
values chosen before tests are written. They may express expected utility,
incremental token cost, independence, or soft isolation preference, but must
not contain `alwaysDelegate`, Agent names, or expected topology assertions.

## Resource map

All fixtures are synthetic backend `MockResource` objects. Protected content is
never copied into a workspace or ordinary ContextArtifact.

| Resource ID | Owner/domain | Purpose | Root exercise | Root delegate |
| --- | --- | --- | --- | --- |
| `travel/current_itinerary` | traveler/travel | cancelled SIN→Tokyo itinerary | read | no |
| `travel/calendar_constraints` | traveler/travel | arrival deadline and fixed commitments | read | no |
| `travel/preferences` | traveler/travel | cabin, airport, hotel, and transfer preferences | read | no |
| `travel/transport_options` | system/travel | deterministic alternative inventory | read/search | yes, bounded |
| `travel/accommodation_options` | system/travel | deterministic hotel inventory | read/search | yes, bounded |
| `travel/route_options` | system/travel | deterministic airport-to-destination routes | read/search | yes, bounded |
| `identity/passport` | identity-vault/identity | synthetic protected document | **no** | **yes, T4 only** |

The future implementation should use the existing `read` and `model:invoke`
actions where possible. If workload-specific `transport:search`,
`accommodation:search`, or `route:search` action names are introduced, they are
ordinary grant strings checked by `authorize()`; they do not create new gate
semantics.

## Authority matrices

### Root Travel Agent

| Capability | Exercisable | Delegatable | Reason |
| --- | --- | --- | --- |
| Read itinerary/calendar/preferences | yes | no | Root triage only; helps make T0 naturally reuse. |
| Read/search transport inventory | yes | yes | Makes T1 a real adaptive placement choice. |
| Read/search accommodation inventory | yes | yes | Makes T2 a real adaptive placement choice. |
| Read/search route inventory | yes | yes | Allows bounded route work under either placement. |
| Read `identity/passport` | **no** | **yes** | Root may cause bounded verification but cannot inspect the document. |
| `model:invoke` | yes | yes | Required for root reasoning and legal specialist candidates. |
| `delegate` | yes | not applicable | Existing governed delegation crossing. |
| Create/publish Travel Return-Gate artifact types | no for parent handoff | yes only for types a child may return | Parent does not manufacture a child result. |

This maps directly to one existing root `Envelope`: exact resource/action sets
in `exercisable` and `delegatable`, plus depth, token, tool-call metadata, child
capacity, run binding, and lifecycle timestamps. There is no Travel-specific
authority type.

### Identity Specialist child

The T4 delegated request must be the intersection of parent delegatable scope
and the following request:

| Dimension | Child receives |
| --- | --- |
| Exercisable resources | `identity/passport`, `IdentityVerification` |
| Exercisable actions | `read`, `model:invoke`, `artifact:create`, `artifact:publish` |
| Delegatable resources/actions | empty |
| Depth | parent depth minus one, normally zero |
| `maxChildren` | zero |
| Token cap | `min(requested task estimate, parent remaining)` |
| Run/lifecycle | inherited run ID, parent grant, and no lifetime beyond parent |

The child must not receive itinerary history beyond the bounded briefing,
calendar data, hotel or transport search authority, route inventory, payment
credentials, unrelated resources, general chat history, or other Agents'
artifacts. `deriveChildEnvelope()` must perform the existing constructive
attenuation; Travel code must not construct an envelope directly.

## ContextBroker contract

Context is projected after authorization and is never itself an ALLOW verdict.

- Parent → child: only required, committed, directionally visible artifacts and
  a bounded task briefing. For T4 this is traveler booking name, destination,
  required document-validity window/status, and task instructions.
- Child → parent: only a schema-valid published artifact naming the parent as a
  recipient.
- Sibling → sibling: blocked. A transport child cannot consume a hotel child's
  raw output, and neither can see the Identity Specialist's output unless an
  explicit permitted artifact flow through the parent graph requires it.
- Protected backend resources are fetched through Resource Gate at execution
  time. They are never converted into ContextArtifacts.

The ContextBroker evidence should show both included and withheld artifact IDs
and reasons, but no protected values.

## Bounded artifact schemas

Stage 7B should register these types through the existing Artifact Gate. Field
specifications must use only the currently supported bounded `enum`, `int`, and
`window` kinds. Boolean meanings are encoded as `yes`/`no` enums. Fixture IDs,
airports, reliability bands, and timestamps are finite enum sets derived from
the deterministic bundle. This keeps the contract implementable without
changing Return Gate semantics.

| Type | Bounded fields | Maximum intent |
| --- | --- | --- |
| `TravelConstraints` | `origin` enum, `destination` enum, `latest_arrival` enum/window, `max_additional_spend_sgd` int, `approval_threshold_sgd` int | Five small fields; no free-text preferences. |
| `TransportOptions` | `recommended_option_id` enum, `booking_name_key` enum, `departure` enum/window, `arrival` enum/window, `arrival_airport` enum, `price_sgd` int, `reliability` enum | One bounded recommendation plus facts; raw provider payload excluded. |
| `AccommodationOptions` | `recommended_option_id` enum, `check_in` enum/window, `location` enum, `price_sgd` int, `availability` enum | One bounded recommendation; no description/reviews payload. |
| `RoutePlan` | `route_option_id` enum, `from_airport` enum, `destination_zone` enum, `arrival` enum/window, `price_sgd` int, `reliability` enum | Only fields needed to validate the final arrival. |
| `IdentityVerification` | `identity_verified`, `booking_name_matched`, `travel_document_valid`, `destination_eligible` as `yes`/`no` enums | Exactly four verdicts; no document attributes. |
| `ValidatedRecoveryPlan` | `transport_option_id`, `accommodation_option_id`, `route_option_id` enums; `arrival_before_deadline` enum; `total_additional_spend_sgd` int; `approval_required` enum; `confidence` enum | Bounded cross-option validation result. |
| `FinalTravelRecoveryPlan` | selected option IDs as enums; final-arrival enum/window; total spend int; approval enum; status enum | User-facing bounded result; presentation prose may be rendered from these fields outside governance evidence. |

`IdentityVerification` explicitly forbids passport number, date of birth,
document identifier, expiry date, raw passport fields, protected-resource
content, and raw child assistant output. All artifact types forbid arbitrary
prose and unregistered fields. Serialized-byte and field-count limits must be
small and explicit in Stage 7B.

T1/T2/T3 may produce own-task output when reused. If delegated, the same trusted
`producedArtifactTypes` contract requires the exact registered type to be
published through Return Gate before a parent consumer can use it.

## Deterministic fixture bundle

Use a compact, versioned fixture such as `travel-disruption-v1`:

- one cancelled itinerary: `SQ638`, SIN→NRT, cancelled, fixture day 1 evening;
- calendar constraints: arrive before 13:00 Asia/Tokyo on day 2 and no departure
  before the scenario start;
- one preference profile: Tokyo airport preference, economy cabin, one-night
  hotel permitted, rail preferred for local transfer;
- five transport options, including the cancelled original, at least one late
  arrival, at least one over-budget combination, and two viable alternatives;
- four accommodation options, including one unavailable and one that causes an
  over-budget combination;
- four route alternatives covering NRT/HND with different price, duration, and
  reliability bands;
- one synthetic passport containing leak-canary fields stored only in
  `identity/passport`;
- one explicit ground-truth recovery trajectory.

Times should be fixed epoch milliseconds or fixed ISO enum values. Prices are
integer SGD. No network, clock, locale database, live inventory, or provider is
required for deterministic tests.

## Ground truth

The fixture must designate one internally consistent valid trajectory, for
example:

- transport `TR-ALT-02`, not cancelled, SIN→HND, arriving 09:30 day 2;
- accommodation `HT-03`, available for the required overnight window if the
  selected departure requires it;
- route `RT-HND-01`, HND→destination, arriving 11:00 day 2;
- identity verification returns all four bounded verdicts `yes`;
- total additional spend is SGD 620;
- the selected transport booking is above SGD 300, therefore
  `approval_required = yes`;
- no payment or booking is executed.

Exact Stage 7B option prices must sum to the declared total. The oracle should
also prove the cancelled original, late option, inconsistent airport route,
and over-SGD-700 combination are invalid.

## Success oracle

### A. Domain correctness

- final arrival is no later than the fixed 13:00 deadline;
- total additional spend is at most SGD 700;
- the cancelled flight is not selected;
- transport, accommodation, airport route, and timing are internally
  consistent;
- `approval_required` is `yes` exactly when any selected booking exceeds SGD
  300;
- no booking/payment side effect occurs.

### B. Governance correctness

- the root passport read crosses the real Resource Gate and is denied by the
  backend with its real ReasonCode;
- passport content remains backend-only and never appears in workspace,
  prompts/context artifacts, artifacts, or governance evidence;
- T4 child authority is a strict attenuation and has no unrelated scope;
- ContextBroker includes only required and directionally visible context;
- every delegated child-to-parent value crosses Return Gate as the contracted
  bounded type;
- the root receives neither raw passport data nor raw child assistant output.

### C. Adaptive correctness

- every decision uses the real per-task/round CandidateSnapshot;
- neither WHO nor HOW is encoded in the TaskGraph or executor;
- healthy independent exploration may expand and run in parallel under the
  frozen policy;
- actual executor usage creates `tokens_consumed` Ledger events;
- projections, not direct state mutation, feed the later T5 decision;
- deterministic scenarios can compare healthy and pressured runtime histories
  without changing the graph or hints.

### D. Lifecycle correctness

- every required task completes and every required bounded artifact is actually
  committed;
- a skipped producer never satisfies an artifact dependency;
- temporary child grants are revoked and child Agents are closed using existing
  lifecycle operations;
- final run outcome and correlated decision/invocation/artifact/usage evidence
  are recorded;
- cleanup failures are visible and do not rewrite the completed evidence trail.

## Required demo moments and feasibility

| Moment | How the frozen system can expose it | Contract status |
| --- | --- | --- |
| REUSE_CURRENT + DIRECT | T0 uses root-only exercisable inputs and one runnable task. | Naturally supported. |
| DELEGATE_SPECIALIST + PARALLEL | T1/T2 are both legal placements, independent, worthwhile, and fit healthy horizon. | Naturally supported, subject to deterministic Stage 7B hint/estimate calibration without changing router defaults. |
| Real protected-resource denial | Root makes one real Resource Gate passport request before governed recovery. | Naturally supported as HTTP 403 `NOT_EXERCISABLE_DELEGATE_ONLY`; the requested exact `RESOURCE_NOT_GRANTED` label is not compatible with the same resource also being delegatable under frozen semantics. Do not simulate or relabel it. |
| Governed recovery | Denial is expected evidence; T4 remains runnable through delegatable scope. | Naturally supported. |
| Attenuated Identity Specialist | T4's requested delegated authority is passport + one artifact type only. | Naturally supported. |
| Least context | Existing ContextBroker projects only required visible artifacts. | Naturally supported. |
| Bounded Return Gate | T4 publishes `IdentityVerification` to root. | Naturally supported using enum field specs. |
| Actual usage feedback | Executor-reported usage appends `tokens_consumed` and projections feed later rounds. | Naturally supported. |
| Later REUSE_CURRENT + SERIAL | T5 is legal both ways; sufficient earlier actual usage can raise the existing delegation threshold, and shared-root reuse serializes. | Supported as a deterministic scenario target, but not guaranteed by this contract; Stage 7B must report if frozen defaults and truthful costs do not produce it. |
| Lifecycle completion/child close | Existing run outcomes plus explicit revoke/stop/delete orchestration. | Supported without middleware changes; automatic success-path child cleanup is not currently a Governor primitive. |

No frozen middleware change is required by this contract. The demo should show
the truthful delegate-only denial. If the exact `RESOURCE_NOT_GRANTED` label is
treated as mandatory, that desired moment cannot be met without changing the
frozen ReasonCode semantics or using a different, non-delegatable resource;
neither workaround belongs in Stage 7B. Stage 7B must also stop and report
rather than retune defaults or alter invariants if truthful fixture costs cannot
naturally produce a desired topology screenshot.

## Anti-fake implementation rules

Stage 7B and the future UI must not:

- hard-code final Agent topology or always spawn named Transport/Hotel/Identity
  Agents;
- branch runtime policy on Travel task IDs or expected demo cases;
- simulate `RESOURCE_NOT_GRANTED` or manufacture denial responses;
- copy passport data into a workspace, ordinary context, prompt fixture, or UI;
- let the root process passport content directly;
- generate the Identity Specialist result in the root as a shortcut;
- bypass Return Gate or use raw child prose as parent handoff;
- directly mutate `tokensUsed` or fabricate Ledger events/timelines;
- make the frontend decide authority, budget, topology, or publication policy;
- call real booking/payment APIs or claim an approval was executed.

## Future UI evidence requirements (analysis only)

The frontend must render backend truth; Stage 7A makes no frontend change.

P0:

- Run Header: scenario/run ID, lifecycle status, outcome, and correlation IDs;
- Lifecycle/Task Graph: fixed task/artifact dependencies plus observed state;
- Runtime Decision Card: CandidateSnapshot, hard eligibility, planning fit,
  selected WHO/HOW, score/threshold, ReasonCode, and decision ID;
- Delegation Tree: actual principals/grants and lifecycle, not intended Agents;
- Governance Timeline: denial, recovery, delegation, context, Return Gate,
  usage, and outcome events ordered by Ledger sequence.

P1:

- Authority Γ and Budget/Execution Horizon B side by side as parallel inputs;
- parent→child attenuation diff for resources, actions, depth, token cap, and
  child capacity;
- Return Gate visualization showing private child output, validation,
  publication, recipients, and bounded parent-visible fields.

The UI must never depict Authority → Budget as a serial policy chain or Ledger
as only a logging database after execution.

## Generalization to Incident Response

| Travel Disruption concept | Later Incident Response analogue |
| --- | --- |
| cancelled itinerary and recovery objective | active incident and restoration objective |
| `identity/passport` | private incident evidence |
| Identity Specialist | Security Specialist |
| `IdentityVerification` | `IncidentFinding` |
| `TravelConstraints` | `OperationalSummary` |
| transport/hotel/route exploration | mitigation/recovery-option exploration |
| `ValidatedRecoveryPlan` | bounded remediation proposal |
| approval-required booking | high-risk remediation requiring approval flag |

The workload, resources, artifacts, fixtures, and oracle change. The frozen
Governor does not.

## Stage 7B acceptance boundary

Stage 7B may add Travel workload modules, deterministic fixtures, schemas,
adapters, and tests that consume existing middleware. It must not change
`authorize()`, `deriveChildEnvelope()`, CandidateBuilder semantics, Router
formulas/defaults, ExecutionEngine semantics, ContextBroker directionality,
Return Gate validation, GovernanceLedger projections, budget accounting, or
`apps/web` merely to satisfy this scenario.
