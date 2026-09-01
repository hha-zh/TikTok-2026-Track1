# BACKLOG

One line per finding. Decided at checkpoints, not implemented mid-stream.

## Blocking

- No governance UI. Envelope comparison, decision timeline, delegation tree, budget bar and artifact private/published are all backend-only. Item 19.
- README and docs still describe the middleware-free starter kit.

## Design notes to settle at a checkpoint

- Artifact types share the `resources` namespace: a child needs `SecurityFinding` in `exercisable.resources` to publish. Design §3 lists artifact types as a Set dimension but `Envelope` has no separate field, so they ride in `resources`. Works, but a judge may ask.
- `Envelope.maxToolCalls` is retained authority metadata but is **NOT ENFORCED**:
  there is no `toolCallsUsed` projection. Trusted-tool calls are authorization
  gated, but this build makes no tool-call-budget claim.
- `authorize` accepts `resource` as `string | null | undefined`; the frozen contract says `string | null`. Harmless, worth aligning.
- Trusted tools are three hardcoded stubs in `gates.ts`, not a registry.

## Verified configuration (do not regress)

- Supported: `RUNTIME_PROVIDER=container` + `CODEX_SANDBOX_MODE=danger-full-access` + per-agent `CODEX_HOME`. `local-process` reads the JSON store off disk and is refused by the launcher.
- `container` + `workspace-write` is unreachable: no Codex Landlock in the runtime image.
- Callback target is `host.docker.internal:3000`; `127.0.0.1` fails inside the container.
- `curl` is absent from the runtime image — trusted-tool instructions must use `node -e "fetch(...)"`.
- Protected resources (`payments/*`, `sec/INC-42`) exist only behind `/api/resources/*` and must never be written to a workspace.

## Adaptive Runtime notes

- `estimatedTokens` on a TaskNode is caller-supplied and unvalidated. The Router
  uses it for `planningFit` only; `ESTIMATED_SHORTFALL` is not hard exhaustion,
  and real accounting still comes from `tokens_consumed` after a call returns.
  Do not claim pre-reservation.
- Router `DEFER` on a required-but-unaffordable node assumes estimates are pessimistic and real usage may leave room. If estimates prove optimistic this becomes a livelock; the ExecutionEngine needs a defer ceiling.
- `CandidateBuilder` derives a throwaway envelope with probe ids to test scope
  eligibility. The real envelope is minted by `DelegationService` at execution
  time; the probe is discarded and never persisted.
- DEMO DESIGN: with the current fixture no resource-bearing task is legal BOTH ways — `app/*` is exercisable-only and `sec/INC-42` delegatable-only — so the soft REUSE-vs-DELEGATE choice only fires on resource-free reasoning tasks. The Todo graph needs reasoning steps (or a resource in both sets) or the adaptive choice will never be visible on stage.
- Routing hints (`specialistRequired`, `independent`, `expectedUtilityGain`, `expectedIncrementalCost`) are DECLARED by the graph author, not observed telemetry. Do not present them as measured.
- `ExecutionEnvelope` is a planning and context-scoping view only. Nothing downstream may treat it as permission; `authorize()` against the grant remains the only ALLOW/DENY source.
- SCHEMA NEED (Return Gate): if the Todo demo wants a child to hand `ui_plan` or `test_plan` to its parent, those need registered bounded artifact types with per-field specs, added through the existing Artifact Gate the way `SecurityFinding v1` was. Do NOT add a generic free-text artifact type as a shortcut - that would reopen the declassification channel the Return Gate exists to bound. Fields must be enums/bounded ints/structured shapes, never prose.

## Todo workload notes

- The integrated suite remains the DETERMINISTIC evidence layer: real Resource
  Gate, DelegationService and Artifact Gate, with injected execution rather
  than a provider call. Separately, the final isolated AgentService/Codex/
  container/Ark probe is **PROVEN**; it exercised real allow/deny, recovery,
  narrower delegation and the bounded Return Gate without changing normal
  application Agent state. Keep the two evidence layers labelled separately.
- Artifact visibility is directional: own task output flows to its producer and that producer's descendants. Parent->child is briefing, child->parent needs the Return Gate, sibling->sibling never. This surfaced when a delegated planner could not see the workspace_summary its own parent produced.
- `optional_reviewer` is dropped by budget pressure, not by policy. If a scenario needs it dropped for another reason, add the reason rather than lowering its utility hint.
- Routing constants are still the initial declared heuristics. Tuning should come from a scenario matrix over this graph, not intuition; `RouterPolicy` and `EnginePolicy` are injectable so no routing change is needed.
- External Container/Codex/Ark execution is now proven by the isolated WSL
  probe. The injected-runner suite remains the deterministic CI layer; the two
  evidence layers must still be reported separately.
- `GovernedProbeRunner` encodes the task id in the prompt (`[bouncer-task:<id>]`) so the injected runner knows what to do. A real Codex agent would be told the same thing in prose; if the prompt format changes, that runner needs updating.

## Phase 6 findings

- HG-14 COMPLETE MEDIATION IS PARTIAL. Resource, Trusted Tool, Delegation and Artifact/Return mediate every crossing through authorize(). Model/Budget does not: it is a pre-dispatch gate on accumulated usage, so a container may make several model calls inside one dispatch that are never individually intercepted and are accounted only from the usage the runtime reports. The claim that holds is "once a run's budget is exhausted, no further dispatch occurs". Do not upgrade this to per-call mediation without a real model proxy.
- Static Single completes the `withheld_artifact` scenario where Static Multi and Adaptive fail it. That is correct, not a bug: under REUSE the planner's output never crosses a principal boundary, so no publication is required. The failure is a property of delegation, which is what the Return Gate is for.
- `authorize()` median overhead measured at sub-microsecond on this machine. That is an in-process figure on a hand-built GovernanceState; it is not end-to-end request latency.

## Phase 6C findings

- `maxChildren` is enforced by `authorize()` on the AUTHORITY axis, not by the budget view. Exhausting child slots yields `MAX_CHILDREN_EXCEEDED`, never a budget denial. The explanatory `ConstraintAxis` calls it `EXECUTION_HORIZON` — that names the dimension, it does not move the enforcement. AB-04 asserts the truth, not the tidier story.
- `pressureWeight` went 2 → 6 when the remaining-budget divisor was removed from `delegationValue`. Removing the divisor changed the value scale, so the old weight no longer flipped AB-02 to REUSE. This is a rescale, not a tuning result; nothing was fitted to data.
- `candidate.feasible` was removed. Eligibility is expressed only through
  `hardEligible` / `planningFit` / `routableNow`.
- One manual usage write remains, in `authority-budget.test.ts`: the grant-vs-run divergence fixture (grant nearly spent, run barely touched). The workload cannot reach that state through the ledger because the parent grant cap equals the run cap, so it would need a child grant absorbing run tokens. It is a unit test of the budget VIEW, and it makes no feedback-loop claim. Everything in `feedback-loop.test.ts` is execution-driven.
- `TopologyPolicyMode` governs the WHO axis only. HOW (DIRECT/SERIAL/PARALLEL) is still decided by its own inputs, so `ALWAYS_DELEGATE` can still serialise when headroom is thin — visible in the `delegation_capacity_pressure` row of the matrix.
- The final external probe used isolated state, the existing runtime image and
  configured Ark endpoint. It passed without changing the normal Agent store.
