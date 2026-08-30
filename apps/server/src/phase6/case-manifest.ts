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
    claim: "A run token authenticates to exactly one principal, grant and run.",
    evidence: [
      "run-token.test.ts > round-trips a minted token",
      "live-runtime.test.ts > hands the CHILD run token to the child's RunnerRequest",
    ],
    expected: "claims.principalId / grantId / runId match the child",
    events: [],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-02",
    claim: "A forged, edited, foreign-key or expired token is refused.",
    evidence: [
      "run-token.test.ts > rejects a token whose payload was edited",
      "identity.test.ts > does not fall through to the human path when the token is forged",
    ],
    expected: "INVALID_TOKEN",
    events: [],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-03",
    claim: "The token governs; a spoofed human header cannot override it.",
    evidence: ["identity.test.ts > lets the token govern when a human header is also spoofed"],
    expected: "identity resolves to the agent principal, header ignored",
    events: [],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-04",
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
    id: "HG-05",
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
    id: "HG-06",
    claim: "A delegate-only resource is refused to the parent that may delegate it.",
    evidence: ["fixtures.test.ts", "adaptive.test.ts > routes a delegate-only resource to delegation"],
    expected: "NOT_EXERCISABLE_DELEGATE_ONLY on sec/INC-42",
    events: ["resource_denied"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-07",
    claim: "A tool outside the action set is refused.",
    evidence: ["gates.test.ts", "fixtures.test.ts > withholds the production patch tool"],
    expected: "ACTION_NOT_GRANTED on apply_production_patch",
    events: ["tool_denied"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-08",
    claim: "Revocation blocks every subsequent mediated descendant action.",
    evidence: [
      "revocation.test.ts",
      "artifacts.test.ts > blocks publication after the parent grant is revoked mid-flight",
      "execution-engine.test.ts > stops mediated work when the grant is revoked between planning and dispatch",
    ],
    expected: "PARENT_GRANT_REVOKED",
    events: ["grant_revoked"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-09",
    claim: "A child cannot receive authority outside the parent's delegatable set.",
    evidence: [
      "delegation.test.ts",
      "delegated-agent-launcher.test.ts > rejects widening before creating a real Agent or child authority",
    ],
    expected: "CHILD_EXCEEDS_PARENT",
    events: ["authority_evaluated"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "HG-10",
    claim: "Bound dimensions clamp to the parent's remaining rather than rejecting.",
    evidence: ["delegation.test.ts"],
    expected: "child maxTokens <= min(parent remaining, requested)",
    events: ["authority_evaluated"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "HG-11",
    claim: "Delegation depth and maxChildren bound fan-out.",
    evidence: ["authorize.test.ts", "adaptive.test.ts > reports the capacity denial when depth is exhausted"],
    expected: "DELEGATION_CEILING_REACHED / MAX_CHILDREN_EXCEEDED",
    events: ["authority_evaluated"],
    level: "unit",
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
    claim:
      "A child result reaches another principal only if published, schema-valid " +
      "and addressed to that principal.",
    evidence: [
      "artifacts.test.ts (Return Gate suite)",
      "todo-run.test.ts > admits the published bounded plans",
      "live-runtime.test.ts > admits the plans only as published bounded artifacts",
    ],
    expected: "ARTIFACT_SCHEMA_VIOLATION / ARTIFACT_NOT_PUBLISHED / ARTIFACT_NOT_RECIPIENT",
    events: ["artifact_created", "artifact_published", "artifact_rejected"],
    level: "e2e",
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
    claim: "A governance denial is never rescued by budget or routing utility.",
    evidence: [
      "adaptive.test.ts > never invents an allow for a task governance denied",
      "execution-engine.test.ts > blocks a task governance denied, however much budget is spare",
      "todo-run.test.ts > is not rescued by spare budget or routing utility",
    ],
    expected: "BLOCKED, governanceReason preserved verbatim",
    events: ["routing_decision", "task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-02",
    claim: "With no declared benefit to extra agency the runtime reuses the current principal.",
    evidence: ["adaptive.test.ts > reuses when both are legal and nothing suggests extra agency"],
    expected: "REUSE_CURRENT",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-03",
    claim: "Declared marginal benefit above the threshold selects a specialist.",
    evidence: ["adaptive.test.ts > delegates when declared marginal benefit clears the threshold"],
    expected: "DELEGATE_SPECIALIST, delegationValue >= delegationThreshold",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-04",
    claim:
      "The same graph with the same hints changes topology from runtime state alone: " +
      "run-budget pressure raises the delegation bar.",
    evidence: [
      "adaptive.test.ts > raises the delegation bar from RUN pressure, not from the grant cap",
      "todo-run.test.ts > changes topology on the same graph",
      "measurement.test.ts (relaxed vs pressured scenarios)",
    ],
    expected: "relaxed -> DELEGATE+PARALLEL; pressured -> REUSE+SERIAL",
    events: ["routing_decision"],
    level: "e2e",
    status: "PROVEN",
  },
  {
    id: "AR-05",
    claim: "Executor strategy and execution mode are independent dimensions.",
    evidence: [
      "adaptive.test.ts > runs an independent REUSE alongside an independent DELEGATE",
      "execution-engine.test.ts > runs an independent REUSE beside an independent DELEGATE in one wave",
    ],
    expected: "PARALLEL across distinct executors",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-06",
    claim: "Two tasks on the one current principal cannot run concurrently.",
    evidence: ["adaptive.test.ts > serialises two REUSE tasks"],
    expected: "SERIAL, two waves",
    events: ["routing_decision"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-07",
    claim: "Work beyond the parallel width is preserved as extra waves, never dropped.",
    evidence: [
      "adaptive.test.ts > preserves work as extra waves when parallel capacity is 1",
      "execution-engine.test.ts > serialises the same assignments when parallel capacity is 1",
    ],
    expected: "DEGRADE, not SKIP",
    events: ["runtime_degraded"],
    level: "unit",
    status: "PROVEN",
  },
  {
    id: "AR-08",
    claim: "A required artifact is satisfied only by an actual commit, never by a skipped producer.",
    evidence: [
      "adaptive.test.ts > does not satisfy a required artifact from a skipped producer",
      "execution-engine.test.ts > blocks the run when a skipped producer owed a required artifact",
      "todo-run.test.ts > holds implementation back until both plans are committed",
    ],
    expected: "UNREACHABLE",
    events: ["task_skipped", "task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-09",
    claim: "A task that did not produce what it promised is not marked complete.",
    evidence: [
      "execution-engine.test.ts > does not mark a task completed when it did not produce what it promised",
      "execution-engine.test.ts (produced artifact type contract suite)",
    ],
    expected: "EXECUTION_FAILED, artifact not committed",
    events: ["task_failed"],
    level: "integration",
    status: "PROVEN",
  },
  {
    id: "AR-10",
    claim: "A permanently unaffordable required task terminates instead of livelocking.",
    evidence: ["execution-engine.test.ts > terminates on the defer ceiling instead of livelocking"],
    expected: "DEFER_CEILING within maxDeferPerTask + 1 rounds",
    events: ["task_deferred"],
    level: "integration",
    status: "PROVEN",
  },
];

export const ALL_CASES: CaseRecord[] = [
  ...HARD_GOVERNANCE_CASES,
  ...ADAPTIVE_RUNTIME_CASES,
];

/** The boundaries HG-14 claims complete mediation over. */
export const BOUNCER_BOUNDARIES = [
  "Resource",
  "Trusted Tool",
  "Model/Budget",
  "Delegation",
  "Artifact/Return",
] as const;
