# BACKLOG

One line per finding. Decided at checkpoints, not implemented mid-stream.

## Blocking

- No governance UI. Envelope comparison, decision timeline, delegation tree, budget bar and artifact private/published are all backend-only. Item 19.
- README and docs still describe the middleware-free starter kit.

## Design notes to settle at a checkpoint

- Artifact types share the `resources` namespace: a child needs `SecurityFinding` in `exercisable.resources` to publish. Design §3 lists artifact types as a Set dimension but `Envelope` has no separate field, so they ride in `resources`. Works, but a judge may ask.
- `Envelope.maxToolCalls` is inert — nothing tracks `toolCallsUsed` and the budget check is tokens-only. Either enforce it or drop the field.
- `authorize` accepts `resource` as `string | null | undefined`; the frozen contract says `string | null`. Harmless, worth aligning.
- Trusted tools are three hardcoded stubs in `gates.ts`, not a registry.

## Verified configuration (do not regress)

- Supported: `RUNTIME_PROVIDER=container` + `CODEX_SANDBOX_MODE=danger-full-access` + per-agent `CODEX_HOME`. `local-process` reads the JSON store off disk and is refused by the launcher.
- `container` + `workspace-write` is unreachable: no Codex Landlock in the runtime image.
- Callback target is `host.docker.internal:3000`; `127.0.0.1` fails inside the container.
- `curl` is absent from the runtime image — trusted-tool instructions must use `node -e "fetch(...)"`.
- Protected resources (`payments/*`, `sec/INC-42`) exist only behind `/api/resources/*` and must never be written to a workspace.

## Adaptive Runtime notes

- `estimatedTokens` on a TaskNode is caller-supplied and unvalidated. The Router uses it for feasibility only; real accounting still comes from `tokens_consumed` after a call returns. Do not claim pre-reservation.
- Router `DEFER` on a required-but-unaffordable node assumes estimates are pessimistic and real usage may leave room. If estimates prove optimistic this becomes a livelock; the ExecutionEngine needs a defer ceiling.
- `CandidateBuilder` derives a throwaway envelope with probe ids to test scope feasibility. The real envelope is minted by `DelegationService` at execution time; the probe is discarded and never persisted.
- DEMO DESIGN: with the current fixture no resource-bearing task is legal BOTH ways — `app/*` is exercisable-only and `sec/INC-42` delegatable-only — so the soft REUSE-vs-DELEGATE choice only fires on resource-free reasoning tasks. The Todo graph needs reasoning steps (or a resource in both sets) or the adaptive choice will never be visible on stage.
- Routing hints (`specialistRequired`, `independent`, `expectedUtilityGain`, `expectedIncrementalCost`) are DECLARED by the graph author, not observed telemetry. Do not present them as measured.
- `ExecutionEnvelope` is a planning and context-scoping view only. Nothing downstream may treat it as permission; `authorize()` against the grant remains the only ALLOW/DENY source.
- SCHEMA NEED (Return Gate): if the Todo demo wants a child to hand `ui_plan` or `test_plan` to its parent, those need registered bounded artifact types with per-field specs, added through the existing Artifact Gate the way `SecurityFinding v1` was. Do NOT add a generic free-text artifact type as a shortcut - that would reopen the declassification channel the Return Gate exists to bound. Fields must be enums/bounded ints/structured shapes, never prose.

## Todo workload notes

- The integrated run is exercised with DETERMINISTIC adapters: real Resource Gate, real DelegationService, real Artifact Gate, but no model call and no container. A real AgentService/Codex/container probe has NOT been run - Docker was not running on this host and the runtime image was absent. Do not claim end-to-end runtime verification until that probe exists and is labelled separately.
- Artifact visibility is directional: own task output flows to its producer and that producer's descendants. Parent->child is briefing, child->parent needs the Return Gate, sibling->sibling never. This surfaced when a delegated planner could not see the workspace_summary its own parent produced.
- `optional_reviewer` is dropped by budget pressure, not by policy. If a scenario needs it dropped for another reason, add the reason rather than lowering its utility hint.
- Routing constants are still the initial declared heuristics. Tuning should come from a scenario matrix over this graph, not intuition; `RouterPolicy` and `EnginePolicy` are injectable so no routing change is needed.
- External container/Codex/Ark probe: NOT RUN. Docker daemon not running, `volc-agent-runtime:local` absent, no `.env` in this repo. The live AgentService integration is proven with an injected AgentRunner; that is a substitute for the MODEL only, never for the governance path. Report the two layers separately.
- `GovernedProbeRunner` encodes the task id in the prompt (`[bouncer-task:<id>]`) so the injected runner knows what to do. A real Codex agent would be told the same thing in prose; if the prompt format changes, that runner needs updating.
