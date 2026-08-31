/**
 * Phase 6 case manifest — every Track 1 claim mapped to deterministic evidence.
 *
 * This is a MAPPING exercise, not a test-count exercise. Almost every case
 * points at a test that already exists; cases were added only where a claim was
 * genuinely uncovered.
 *
 * The HG/AR identifiers follow the frozen design's invariants and the Build
 * Brief's negative-test list. Where a case is only PARTIALLY proven that is
 * stated here rather than softened - a manifest that grades itself generously
 * is worse than none.
 */

export type CaseLevel = "unit" | "integration" | "e2e";

export type CaseStatus =
  /** Claim is fully backed by the listed evidence. */
  | "PROVEN"
  /** Backed only within a stated narrower boundary. `limitation` says which. */
  | "PARTIAL"
  /** Cannot be proven in this environment. `limitation` says why. */
  | "NOT_RUN";

export interface CaseRecord {
  id: string;
  claim: string;
  /** Test titles or files that provide the evidence. */
  evidence: string[];
  /** Expected verdict, ReasonCode or topology. */
  expected: string;
  /** Ledger event kinds the case should leave behind. */
  events: string[];
  level: CaseLevel;
  status: CaseStatus;
  limitation?: string;
}

// ---------------------------------------------------------------------------
// Hard Governance
// ---------------------------------------------------------------------------

export const HARD_GOVERNANCE_CASES: CaseRecord[] = [
  {
    id: "HG-01",
    claim: "A principal may read a resource inside its exercisable scope.",
    evidence: [
      "gates.test.ts",
      "fixtures.test.ts > produces a root grant that resolves and authorizes end to end",
    ],
    expected: "ALLOW on app/metrics",
    events: ["resource_allowed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-02",
    claim: "A cross-owner read is refused by the backend, not by the model.",
    evidence: [
      "todo-run.test.ts > is the backend that refuses the cross-principal read, not the model",
      "live-runtime.test.ts > still lets the backend refuse the cross-principal read",
    ],
    expected: "RESOURCE_NOT_GRANTED on payments/private_incident.json",
    events: ["resource_denied"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "HG-03",
    claim: "A delegate-only resource is refused to the parent that may delegate it.",
    evidence: ["fixtures.test.ts", "delegation.test.ts > proves parent denied on delegate-only resource while the persisted child is allowed"],
    expected: "NOT_EXERCISABLE_DELEGATE_ONLY on sec/INC-42",
    events: ["resource_denied"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-04",
    claim: "A forged, edited, foreign-key or expired token is refused.",
    evidence: [
      "run-token.test.ts > rejects a modified payload",
      "identity.test.ts > does not fall through to a human header for a forged agent token",
    ],
    expected: "INVALID_TOKEN",
    events: [],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-05",
    claim: "A spoofed human header cannot override the authenticated Runtime token.",
    evidence: ["delegation.test.ts > does not let a human header impersonate Runtime delegation"],
    expected: "Runtime identity governs; spoofed human header is ignored or refused",
    events: [],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-06",
    claim: "Revocation of any ancestor blocks every subsequent mediated descendant action.",
    evidence: ["authorize.test.ts > checks ancestor revocation", "revocation.test.ts"],
    expected: "PARENT_GRANT_REVOKED",
    events: ["grant_revoked"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-07",
    claim: "A child cannot receive authority outside the parent's delegatable set.",
    evidence: ["delegation.test.ts", "delegated-agent-launcher.test.ts > rejects widening before creating a real Agent or child authority"],
    expected: "CHILD_EXCEEDS_PARENT",
    events: ["authority_evaluated"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-08",
    claim: "Bound dimensions clamp to the parent's remaining authority rather than widening.",
    evidence: ["delegation.test.ts > clamps numeric ceilings downward including effective remaining tokens"],
    expected: "child bounds <= min(parent remaining, requested)",
    events: ["authority_evaluated"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-09",
    claim: "Delegation depth and maxChildren bound fan-out.",
    evidence: ["authorize.test.ts", "adaptive.test.ts > reports the capacity denial, not a scope denial, when depth is exhausted"],
    expected: "DELEGATION_CEILING_REACHED / MAX_CHILDREN_EXCEEDED",
    events: ["authority_evaluated"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-10",
    claim: "The Return Gate rejects an artifact that violates its registered schema.",
    evidence: ["artifacts.test.ts > refuses a schema violation and leaves the artifact unpublished", "case-manifest.test.ts > Artifact/Return: refuses a schema-violating publication"],
    expected: "ARTIFACT_SCHEMA_VIOLATION",
    events: ["artifact_rejected"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-11",
    claim: "A sibling or other nonrecipient cannot read a governed artifact.",
    evidence: ["artifacts.test.ts > withholds a published artifact from a sibling child", "context-broker.test.ts > withholds a published artifact from a principal that is not a recipient"],
    expected: "ARTIFACT_NOT_RECIPIENT or withheld context",
    events: ["artifact_rejected"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-12",
    claim:
      "Once a run's budget is exhausted every subsequent mediated call is blocked; " +
      "overshoot is bounded by one in-flight call per principal.",
    evidence: ["authorize.test.ts", "execution-engine.test.ts > routes the next round from actual usage"],
    expected: "BUDGET_EXCEEDED once min(grant, run) remaining <= 0",
    events: ["tokens_consumed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-13",
    claim: "Every governed child uses isolated workspace, CODEX_HOME and thread state.",
    evidence: ["delegated-agent-launcher.test.ts > uses isolated workspace, CODEX_HOME and a fresh thread without copying resources"],
    expected: "per-agent CODEX_HOME and workspace; fresh thread",
    events: [],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-14",
    claim:
      "Complete mediation over Bouncer-managed boundaries: Resource, Trusted Tool, " +
      "Model/Budget, Delegation, Artifact/Return.",
    evidence: ["case-manifest.test.ts > HG-14 enumerates every Bouncer-managed boundary"],
    expected: "each boundary refuses at least one request through authorize()",
    events: ["resource_denied", "tool_denied", "authority_evaluated", "artifact_rejected"],
    level: "integration",
    // See MODEL_CROSSING_LIMITATION. Four boundaries mediate every crossing;
    // the model boundary mediates per DISPATCH, not per model call.
    status: "PARTIAL",
    limitation:
      "Model/Budget is a pre-dispatch gate on accumulated usage, not a per-model-call " +
      "interception. A container may make several model calls inside one dispatch; those " +
      "are accounted post-hoc from reported usage and are not individually mediated.",
  },
  {
    id: "HG-15",
    claim: "Secret-shaped values are redacted before they reach stored evidence.",
    evidence: [
      "ledger.test.ts (redaction)",
      "todo-run.test.ts > keeps raw content out of the persisted evidence",
    ],
    expected: "no protected fixture content or credential-shaped string in the ledger",
    events: [],
    level: "integration",
    status: "PROVEN",
  },
];

/**
 * The specific, honest limitation behind HG-14's PARTIAL status.
 *
 * Reported rather than papered over: the Model/Budget boundary is mediated at
 * dispatch granularity. `authorize(model:invoke)` is consulted when a task is
 * routed, and `min(grantRemaining, runRemaining)` is checked immediately before
 * dispatch, but a real Codex container talks to the model provider directly.
 * Those individual calls do not cross a Bouncer gate; they are accounted after
 * the fact from the usage the runtime reports.
 *
 * The claim that holds: once a run's budget is exhausted, no further DISPATCH
 * occurs. The claim that does not: that every model call is individually
 * mediated.
 */
export const MODEL_CROSSING_LIMITATION = {
  boundary: "Model/Budget",
  mediatedAt: "dispatch",
  notMediatedAt: "individual model call inside a dispatch",
  accounting: "post-hoc, from reported usage via tokens_consumed",
} as const;

// ---------------------------------------------------------------------------
// Adaptive Runtime
// ---------------------------------------------------------------------------

export const ADAPTIVE_RUNTIME_CASES: CaseRecord[] = [
  {
    id: "AR-01",
    claim: "A simple read-heavy task reuses the current principal and executes directly.",
    evidence: ["adaptive.test.ts > reuses when both are legal and nothing suggests extra agency is worth it", "adaptive.test.ts > is DIRECT for a single unit of work", "measurement.test.ts > simple_read_heavy adaptive row"],
    expected: "REUSE_CURRENT + DIRECT",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-02",
    claim: "Independent planners under a healthy budget delegate to specialists in parallel.",
    evidence: ["todo-run.test.ts > delegates both planners and runs them in one parallel wave", "authority-budget.test.ts > AB-01 — Todo, relaxed budget"],
    expected: "DELEGATE_SPECIALIST + PARALLEL",
    events: ["routing_decision"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AR-03",
    claim: "The same workload under budget pressure uses less agency and may skip optional work.",
    evidence: ["todo-run.test.ts > changes topology on the same graph: reuse, serial, reviewer dropped", "authority-budget.test.ts > AB-02 — the same Todo graph under budget pressure"],
    expected: "REUSE_CURRENT + SERIAL; optional SKIP where applicable",
    events: ["routing_decision", "task_skipped"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AR-04",
    claim: "A hard-illegal candidate is removed before adaptive scoring can choose it.",
    evidence: ["adaptive.test.ts > never invents an allow for a task governance denied", "authority-budget.test.ts > cannot delegate work the principal may only perform itself"],
    expected: "illegal placement cannot be selected by router utility",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-05",
    claim: "High utility, spare budget or isolation preference cannot override a hard governance denial.",
    evidence: ["execution-engine.test.ts > blocks a task governance denied, however much budget is spare", "todo-run.test.ts > is not rescued by spare budget or routing utility", "authority-budget.test.ts > AB-06 — revocation overrides budget"],
    expected: "BLOCKED with the original hard ReasonCode",
    events: ["routing_decision", "task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-06",
    claim: "The same principal executes different tasks under distinct narrowed invocation ExecutionEnvelopes without spawning.",
    evidence: ["adaptive.test.ts > narrows to principal ∩ task and never widens"],
    expected: "distinct per-task ExecutionEnvelope views; no child required",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-07",
    claim: "Implementation waits until every required artifact is actually committed.",
    evidence: ["todo-run.test.ts > holds implementation back until both plans are committed", "execution-engine.test.ts > blocks the run when a skipped producer owed a required artifact"],
    expected: "consumer is not dispatched while required artifacts are absent",
    events: ["task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-08",
    claim: "Context projection includes only required and directionally authorized artifacts.",
    evidence: ["context-broker.test.ts > withholds everything the task does not require", "context-broker.test.ts > still refuses a sibling's output even with an ancestry supplied", "live-runtime.test.ts > gives it nothing the ContextBroker withheld"],
    expected: "least-context projection; forbidden or unrelated artifacts withheld",
    events: [],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-09",
    claim: "A malicious or forbidden resource request is denied by the backend and the run recovers understandably.",
    evidence: ["todo-run.test.ts > is the backend that refuses the cross-principal read, not the model", "measurement.test.ts > malicious_forbidden_resource adaptive row"],
    expected: "RESOURCE_NOT_GRANTED; non-critical path recovers and run completes",
    events: ["resource_denied", "task_completed"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AR-10",
    claim: "Identical deterministic inputs produce reproducible evidence and topology outcomes.",
    evidence: ["delegation.test.ts > emits the deterministic successful evidence sequence", "measurement.test.ts > Phase 6 baseline fairness"],
    expected: "stable evidence ordering and repeatable policy/scenario outcomes",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
];

// Useful implementation evidence displaced by the canonical HG/AR numbering.
// These identifiers are verification-only and are never consumed by runtime policy.
export const EXTENSION_EVIDENCE_CASES: CaseRecord[] = [
  {
    id: "EX-HG-01",
    claim: "A run token binds exactly one principal, grant and run.",
    evidence: ["run-token.test.ts", "live-runtime.test.ts > hands the CHILD run token to the child's RunnerRequest"],
    expected: "token claims match the executing child",
    events: [], level: "integration", status: "PROVEN",
  },
  {
    id: "EX-HG-02",
    claim: "A trusted tool outside the action set is refused.",
    evidence: ["gates.test.ts", "fixtures.test.ts > withholds the production patch tool"],
    expected: "ACTION_NOT_GRANTED", events: ["tool_denied"], level: "integration", status: "PROVEN",
  },
  {
    id: "EX-AR-01",
    claim: "WHO and HOW remain independent routing dimensions.",
    evidence: ["adaptive.test.ts > runs an independent REUSE alongside an independent DELEGATE"],
    expected: "mixed placements may share a PARALLEL wave", events: ["routing_decision"], level: "unit", status: "PROVEN",
  },
  {
    id: "EX-AR-02",
    claim: "Parallel-capacity overflow becomes extra waves rather than dropped work.",
    evidence: ["adaptive.test.ts > preserves work as extra waves when parallel capacity is 1"],
    expected: "DEGRADE, not SKIP", events: ["runtime_degraded"], level: "unit", status: "PROVEN",
  },
  {
    id: "EX-AR-03",
    claim: "A task missing a promised output is not marked complete.",
    evidence: ["execution-engine.test.ts > does not mark a task completed when it did not produce what it promised"],
    expected: "EXECUTION_FAILED", events: ["task_failed"], level: "integration", status: "PROVEN",
  },
  {
    id: "EX-AR-04",
    claim: "A permanently unaffordable required task terminates rather than livelocking.",
    evidence: ["execution-engine.test.ts > terminates on the defer ceiling instead of livelocking"],
    expected: "DEFER_CEILING", events: ["task_deferred"], level: "integration", status: "PROVEN",
  },
];

// ---------------------------------------------------------------------------
// Authority × Budget interaction
// ---------------------------------------------------------------------------

/**
 * BACKEND VERIFICATION CASES.
 *
 * These are not the demo language. The scenarios an operator sees are concrete
 * - "Todo with a relaxed budget", "a delegate-only incident slice" - and the AB
 * cases sit underneath them as deterministic proof.
 */
export const AUTHORITY_BUDGET_CASES: CaseRecord[] = [
  {
    id: "AB-01",
    claim:
      "Both placements authorized and affordable, declared benefit clears the " +
      "threshold: agency expands.",
    evidence: [
      "authority-budget.test.ts > AB-01 — Todo, relaxed budget",
      "todo-run.test.ts > delegates both planners and runs them in one parallel wave",
    ],
    expected: "DELEGATE_SPECIALIST, PARALLEL",
    events: ["routing_decision"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AB-02",
    claim:
      "Same graph, same authority, same hints; only runtime budget changes, so " +
      "the extra agency stops being worth its cost.",
    evidence: [
      "authority-budget.test.ts > AB-02 — the same Todo graph under budget pressure",
      "todo-run.test.ts > changes topology on the same graph",
    ],
    expected: "REUSE_CURRENT, SERIAL, optional reviewer SKIPped",
    events: ["routing_decision", "task_skipped"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AB-03",
    claim: "Authority may force topology expansion.",
    evidence: ["authority-budget.test.ts > AB-03 — authority forces topology expansion"],
    expected:
      "REUSE denied NOT_EXERCISABLE_DELEGATE_ONLY while affordable; DELEGATE selected",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AB-04",
    claim: "Hard runtime capacity and an estimated planning shortfall remain distinct.",
    evidence: [
      "authority-budget.test.ts > reports an oversized estimate as a shortfall, not as exhaustion",
      "authority-budget.test.ts > reports genuinely spent budget as hard exhaustion",
      "authority-budget.test.ts > blocks when child capacity is spent",
    ],
    expected:
      "ESTIMATED_SHORTFALL keeps hardEligible true; spent capacity makes hardEligible false",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AB-05",
    claim: "Affordability cannot create permission.",
    evidence: ["authority-budget.test.ts > AB-05 — affordability cannot create permission"],
    expected: "DELEGATE denied CHILD_EXCEEDS_PARENT at any budget; REUSE selected",
    events: ["routing_decision"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AB-06",
    claim: "Revocation overrides budget, utility and isolation preference alike.",
    evidence: ["authority-budget.test.ts > AB-06 — revocation overrides budget"],
    expected: "BLOCKED with PARENT_GRANT_REVOKED, isolation gain 0",
    events: ["routing_decision", "task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AB-07",
    claim:
      "A DECLARED isolation preference may tip an already-legal, already-affordable " +
      "choice toward the structurally narrower principal, and never makes reuse illegal.",
    evidence: ["authority-budget.test.ts > AB-07 — declared isolation preference (soft)"],
    expected: "REUSE without the hint; DELEGATE with it; REUSE stays AUTHORIZED either way",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
];

export const ALL_CASES: CaseRecord[] = [
  ...HARD_GOVERNANCE_CASES,
  ...ADAPTIVE_RUNTIME_CASES,
  ...AUTHORITY_BUDGET_CASES,
  ...EXTENSION_EVIDENCE_CASES,
];

/** The boundaries HG-14 claims complete mediation over. */
export const BOUNCER_BOUNDARIES = [
  "Resource",
  "Trusted Tool",
  "Model/Budget",
  "Delegation",
  "Artifact/Return",
] as const;
