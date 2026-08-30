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
