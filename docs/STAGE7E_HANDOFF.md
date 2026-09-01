# Stage 7E Final Handoff

## 1. Current Goal

The intended product path is:

`Travel Recovery Assistant` (a user-created Agent) → user request → **real** governed Travel execution → runtime delegation, authority checks, context projection, and bounded artifacts → root schema-validated `FinalTravelRecoveryPlan` → `GovernedRunView.finalResult` → deterministic Markdown rendering → persistent assistant message under the user-created Agent.

The Runtime Governance Inspector is a read-only evidence surface. It observes the governed run; it does not advance execution or invent evidence.

## 2. Architecture Boundary

### Persistent user Agent

- Name: `Travel Recovery Assistant`
- `origin = "user"`
- Appears in `YOUR AGENTS`
- Owns the durable user/assistant conversation

### Runtime governed Agents

- Runtime root and delegated child specialists
- `origin = "governed-runtime"`
- Never appear in `YOUR AGENTS`
- Remain available to governed execution and its evidence

Filtering is structural (`origin`), not name-based. An ordinary `AgentRun` ID and a governed `runId` are different identifiers and must not be treated as interchangeable.

## 3. Final Travel Execution Modes

### User-facing path

Normal Travel submission explicitly sends `executionMode = "real"`. The final UI has no execution-mode selector.

### Internal deterministic path

Deterministic execution remains available for tests, CI, offline/reproducible development, and middleware verification. It must never silently replace a failed real run. Real execution is fail-closed.

## 4. Proven Real Provider Path

The exercised path is:

`ContainerCodexRunner` → Codex CLI → Ark → executor-reported usage → `tokens_consumed` → `GovernanceLedger` → `RunState` → `GovernedRunView` → Inspector.

Safe observed evidence:

- Historical Attempt 3: projected usage `115,801`; FAILED because of the then-current passport oracle issue.
- Historical Attempt 4: projected usage `116,174`; PROVEN.
- Completed browser real run `travel-real-d03c9d77-…`: `115,526 / 120,000`.
- Latest persisted completed browser real run `travel-real-adb1893f-…`: `114,918 / 120,000`.

No protected prompts, credentials, raw child output, or secrets are reproduced here.

## 5. Governed Travel Runtime

The declared workload contains seven dependent units of work: understand disruption, search transport, search accommodation, plan local arrival, verify identity, validate the recovery plan, and synthesize the final recovery plan. The workload declares work and dependencies; the Governor decides runtime topology. The LLM does not invent the TaskGraph.

Observed topology includes:

- Transport: `DELEGATE_SPECIALIST / PARALLEL`
- Accommodation: `DELEGATE_SPECIALIST / PARALLEL`
- Identity: root passport access DENY, restricted child authority ALLOW
- Child authority attenuation and least-context projection
- Return Gate validation for cross-principal child results
- Later `REUSE_CURRENT / DIRECT` contraction
- T6 final synthesis as root own-task output

## 6. Return Gate Boundary

Child → parent results cross the Return Gate and become bounded parent-visible artifacts.

Root T6 `final_recovery_plan` is `REUSE_CURRENT / DIRECT`: its own-task output is checked against the registered artifact schema and then stored as the governed `finalResult`. `FinalTravelRecoveryPlan` itself does **not** cross the Return Gate.

## 7. Final User Answer Path

Old, incorrect behavior:

```text
user Send
├─ governed runtime
└─ independent ordinary Codex api.sendMessage()
```

The visible answer was independent of governance.

Current Stage 7E.9 behavior:

```text
user message
→ real governed run
→ validated A_FINAL
→ persisted RunState.finalResult
→ GovernedRunView.finalResult
→ deterministic backend Markdown formatter
→ persistent assistant message under Travel Recovery Assistant
```

The Travel branch does not launch an independent ordinary Codex response. Other ordinary Agents retain the existing `api.sendMessage()` path.

`FinalTravelRecoveryPlan` v1 contains only:

- `transport_option_id`
- `accommodation_option_id`
- `route_option_id`
- `final_arrival`
- `total_additional_spend_sgd`
- `approval_required`
- `status`

The renderer must not invent airline, hotel, route-description, or rationale data beyond these bounded fields.

## 8. Run Pressure Semantics

### Deterministic mode

Reference accounting is `600 + 1800 + 1800 + 1400 + 2000 + 1000 + 800 = 9400`. This is deterministic governed-runtime accounting.

### Real provider mode

Pressure uses that run's executor/provider-reported usage and a `120,000` real-mode cap. Never copy historical totals into a new run or present `9400` as real-provider usage.

## 9. Frontend State

- `YOUR AGENTS` contains only persistent user Agents.
- There is no Real/Deterministic selector.
- Normal Travel Send automatically starts real governed execution.
- The Inspector auto-binds without manual `runId` entry.
- Lifecycle nodes emerge only from runtime evidence.
- Run Pressure comes from persisted backend evidence.
- Assistant Markdown is rendered through the bounded renderer path.
- While governed Travel is active without an ordinary `AgentRun`, chat shows `Governed recovery is running…`.
- The final answer comes from governed `finalResult`.
- Terminal polling stops, and terminal chat refresh waits for the persistent Agent to leave BUSY.

## 10. Current Blocking Issue

### Previous audited failure

Run `travel-real-077ca2e8-…` completed `understand_disruption`, `search_transport`, and `search_accommodation`, then failed at `plan_local_arrival` with usage `58,708 / 120,000`.

Persisted runtime evidence proves: Ark/provider HTTP 429 Too Many Requests → retries exhausted → `ContainerCodexRunner` exit code 1 → runtime `AgentRun` failed → governed run `EXECUTION_FAILED`. This was an external provider failure, not a Stage 7E.9 bridge regression.

### Latest immediate failure

Run `travel-real-ccea85f0-…` failed at the first task, `understand_disruption`, with `0 / 120,000`. No task completed, no `finalResult` was created, and no assistant answer was persisted. The user message persisted and the persistent Travel Agent returned to READY.

The associated runtime `AgentRun` has now been audited. It also records Ark/provider HTTP 429 Too Many Requests, retries exhausted, and container runtime exit code 1. No request identifier or raw runtime content is included here.

## 11. Next Teammate Task

1. Re-read the latest governed run and associated runtime `AgentRun` before acting.
2. Confirm the current provider/container condition; both last failures were persisted 429 failures.
3. Do not modify middleware semantics unless new evidence proves a code regression.
4. Preserve fail-closed behavior; determine a stable retry/rate-limit strategy suitable for the demo, without deterministic fallback.
5. If evidence instead reveals an implementation regression, make the smallest specific correction and preserve the Stage 7E.9 single-governed-answer path.
6. Perform local/static validation, then run exactly one real-provider browser validation.
7. Accept only when all seven tasks complete, actual usage appears, `finalResult` persists, the governed assistant answer appears, the Agent returns READY, Governance is COMPLETED, `YOUR AGENTS` remains user-only, refresh preserves the conversation, and polling stops.

## 12. Required Runtime Configuration

Proven local configuration:

```text
HOST=0.0.0.0
RUNTIME_PROVIDER=container
```

The browser still uses the normal localhost/127.0.0.1 frontend URL. An authenticated `/api/system` should report `arkConfigured: true`, `codexAvailable: true`, `runtimeProvider: container`, `containerEngine: docker`, and Codex CLI in the Docker runtime. `/api/system` requires authentication. Never place `APP_AUTH_TOKEN` or provider credentials in documentation or source.

## 13. Validation State

Latest safe validation before handoff:

- Focused frontend tests passing
- Focused Travel, AgentService, and governance tests passing
- Tracked server repository tests previously passing `431 / 431`
- Typecheck passing
- Production build passing
- `git diff --check` passing

An unscoped test/check can collect unrelated files under `apps/server/.local/codex-home/.tmp/plugins…`. These are external runtime-cache files, not repository test failures; do not commit or modify them.

## 14. Files / Subsystems Most Relevant to Next Fix

- `apps/server/src/app.ts`
- `apps/server/src/agent-service.ts`
- `apps/server/src/middleware/evidence/governed-run-view.ts`
- `apps/server/src/middleware/governance/types.ts`
- `apps/server/src/middleware/runtime/delegated-agent-launcher.ts`
- `apps/server/src/workload/travel-disruption/demo-run.ts`
- `apps/server/src/workload/travel-disruption/live-runtime.ts`
- `apps/server/src/workload/travel-disruption/artifacts.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/AssistantMarkdown.tsx`
- `apps/web/src/governance/`
- `apps/web/src/governance/travelDemo.ts`

## 15. Safety / Do Not Regress

- No raw child output in the frontend.
- No protected resources in the frontend or handoff.
- No secret/token persistence.
- No runtime Agents in `YOUR AGENTS`.
- No name-based runtime-Agent filtering.
- No deterministic fallback masquerading as real.
- No fake pressure or timer-created lifecycle state.
- No fabricated `finalResult`.
- No ordinary Codex Travel response parallel to governed execution.
- Do not change Return Gate semantics.
- Do not conflate ordinary `AgentRun` with governed run.
- Do not force-push.
