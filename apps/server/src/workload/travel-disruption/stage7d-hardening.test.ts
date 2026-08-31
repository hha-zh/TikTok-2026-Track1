import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveEvidenceCorrelated,
  deriveFreshStateChangesWho,
  deriveParentVisibleArtifactsBounded,
  deriveRealCandidateSnapshot,
  type RoutingDecisionEvidence,
} from "./live-proof-evidence.js";
import { identityFindingIsBounded } from "./oracle.js";
import { buildGovernedRunView } from "../../middleware/evidence/governed-run-view.js";
import { travelRunDescriptor } from "./evidence.js";
import { runTravelLifecycle } from "./run.js";
import { TRAVEL_ARTIFACT_SCHEMAS, TYPE_IDENTITY_VERIFICATION } from "./artifacts.js";
import { T1_TRANSPORT, T4_IDENTITY, T5_VALIDATE } from "./graph.js";

const decision = (over: Partial<RoutingDecisionEvidence> = {}): RoutingDecisionEvidence => ({
  taskId: T1_TRANSPORT,
  decisionId: "d1",
  placement: "DELEGATE_SPECIALIST",
  delegationValue: 3.33,
  delegationThreshold: 1.3,
  budget: { runPressure: 0.1 },
  candidates: [{ placement: "REUSE_CURRENT" }, { placement: "DELEGATE_SPECIALIST" }],
  ...over,
});

const early = decision();
const later = decision({
  taskId: T5_VALIDATE, decisionId: "d2", placement: "REUSE_CURRENT",
  delegationThreshold: 4.8, budget: { runPressure: 0.7 },
});

const identityFields = TRAVEL_ARTIFACT_SCHEMAS
  .find((item) => item.artifactType === TYPE_IDENTITY_VERIFICATION)!.allowedFieldNames;

describe("Stage 7D.4 strengthened live-proof predicates", () => {
  describe("realCandidateSnapshot — was: any routing_decision exists", () => {
    it("holds when every decision carries candidate evidence", () => {
      expect(deriveRealCandidateSnapshot([early, later])).toBe(true);
    });

    it("REGRESSION: fails when a decision exists but carries no candidates", () => {
      expect(deriveRealCandidateSnapshot([early, decision({ candidates: [] })])).toBe(false);
    });

    it("REGRESSION: fails when the candidates key is absent entirely", () => {
      expect(deriveRealCandidateSnapshot([decision({ candidates: undefined })])).toBe(false);
    });

    it("is not vacuously true on an empty decision set", () => {
      expect(deriveRealCandidateSnapshot([])).toBe(false);
    });
  });

  describe("freshStateChangesWho — was: any routing_decision for T5 exists", () => {
    it("holds for the intended execution-history story", () => {
      expect(deriveFreshStateChangesWho(early, later)).toBe(true);
    });

    it("REGRESSION: fails when the later threshold did not rise", () => {
      expect(deriveFreshStateChangesWho(early, { ...later, delegationThreshold: 1.3 })).toBe(false);
    });

    it("REGRESSION: fails when run pressure did not rise", () => {
      expect(deriveFreshStateChangesWho(early, { ...later, budget: { runPressure: 0.1 } })).toBe(false);
    });

    it("REGRESSION: fails when WHO did not actually change", () => {
      expect(deriveFreshStateChangesWho(early, { ...later, placement: "DELEGATE_SPECIALIST" })).toBe(false);
    });

    it("REGRESSION: fails when the intrinsic delegation value drifted", () => {
      expect(deriveFreshStateChangesWho(early, { ...later, delegationValue: 9.9 })).toBe(false);
    });

    it("fails when either decision is missing", () => {
      expect(deriveFreshStateChangesWho(undefined, later)).toBe(false);
      expect(deriveFreshStateChangesWho(early, undefined)).toBe(false);
    });
  });

  describe("evidenceCorrelated — was: any run_outcome exists", () => {
    it("holds when every decision correlates to a dispatched invocation", () => {
      expect(deriveEvidenceCorrelated([early, later], new Set(["d1", "d2"]))).toBe(true);
    });

    it("REGRESSION: fails when a decision never reached the dispatch boundary", () => {
      expect(deriveEvidenceCorrelated([early, later], new Set(["d1"]))).toBe(false);
    });

    it("REGRESSION: a terminal outcome with no correlated invocation proves nothing", () => {
      expect(deriveEvidenceCorrelated([early], new Set())).toBe(false);
    });

    it("is not vacuously true on an empty decision set", () => {
      expect(deriveEvidenceCorrelated([], new Set(["d1"]))).toBe(false);
    });
  });

  describe("rawChildOutputAbsentFromParentView — was: view lacks the string 'assistant'", () => {
    const allowed = new Map(TRAVEL_ARTIFACT_SCHEMAS
      .map((item) => [item.artifactType, item.allowedFieldNames] as const));
    const bounded = [{
      type: TYPE_IDENTITY_VERIFICATION,
      boundedFields: { identity_verified: "yes", booking_name_matched: "yes" },
    }];

    it("holds for a schema-bounded parent-visible artifact", () => {
      expect(deriveParentVisibleArtifactsBounded(bounded, allowed)).toBe(true);
    });

    it("REGRESSION: fails when raw child prose is admitted as a field value", () => {
      expect(deriveParentVisibleArtifactsBounded([{
        type: TYPE_IDENTITY_VERIFICATION,
        boundedFields: {
          identity_verified: "I checked the passport and can confirm the traveller's "
            + "document is valid through 2028 and eligible for entry to Japan.",
        },
      }], allowed)).toBe(false);
    });

    it("REGRESSION: fails on an undeclared field name", () => {
      expect(deriveParentVisibleArtifactsBounded([{
        type: TYPE_IDENTITY_VERIFICATION,
        boundedFields: { assistant_reasoning: "ok" },
      }], allowed)).toBe(false);
    });

    it("REGRESSION: fails for an artifact type with no registered schema", () => {
      expect(deriveParentVisibleArtifactsBounded([{ type: "Unregistered", boundedFields: {} }], allowed)).toBe(false);
    });

    it("is not vacuously true on an empty artifact set", () => {
      expect(deriveParentVisibleArtifactsBounded([], allowed)).toBe(false);
    });
  });

  describe("noRawChildHandoff — was: evidence lacks the token 'passportNumber'", () => {
    it("holds for the bounded published identity finding", () => {
      expect(identityFindingIsBounded(
        { identity_verified: "yes", travel_document_valid: "yes" }, identityFields)).toBe(true);
    });

    it("REGRESSION: fails when the child's prose is admitted as a finding field", () => {
      expect(identityFindingIsBounded(
        { identity_verified: "yes, the passport is valid through 2028-05-01" }, identityFields)).toBe(false);
    });

    it("REGRESSION: fails on an undeclared field name", () => {
      expect(identityFindingIsBounded({ raw_child_answer: "yes" }, identityFields)).toBe(false);
    });

    it("is not vacuously true for a missing or empty finding", () => {
      expect(identityFindingIsBounded(undefined, identityFields)).toBe(false);
      expect(identityFindingIsBounded({}, identityFields)).toBe(false);
    });
  });
});

describe("Stage 7D.4 proof-report overwrite guard", () => {
  const scriptPath = path.join(process.cwd(), "..", "..", "scripts", "stage7d-travel-proof.mjs");

  it("refuses to overwrite an existing report, on every write path", async () => {
    const source = await readFile(scriptPath, "utf8");
    // The guard must live inside writeReport itself, which both the success
    // path and the preflight-failure path reach.
    const writeReport = source.slice(source.indexOf("async function writeReport"));
    const body = writeReport.slice(0, writeReport.indexOf("\n}"));
    expect(body).toContain("stat(reportPath)");
    expect(body).toMatch(/refusing to overwrite existing proof report/);
    // The refusal must precede the write, not follow it.
    expect(body.indexOf("refusing to overwrite")).toBeLessThan(body.indexOf("writeFile"));
  });

  it("allows a separately authorized attempt to name a distinct report", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("process.env.TRAVEL_PROOF_REPORT");
  });

  it("never lets the NOT_RUN preflight stub mask or destroy prior evidence", async () => {
    const source = await readFile(scriptPath, "utf8");
    const preflight = source.slice(source.indexOf("preflightProblems.length"));
    const block = preflight.slice(0, preflight.indexOf("const { loadConfig"));
    expect(block).toContain("status: \"NOT_RUN\"");
    // The stub write is best-effort: a refusal must not replace the real
    // preflight error that the operator needs to see.
    expect(block).toMatch(/\.catch\(/);
    expect(block).toContain("real Travel preflight failed");
  });
});

describe("Stage 7D.4 descriptor-absent read model (the production wiring)", () => {
  // index.ts constructs createApp WITHOUT governedRunDescriptor, so this is the
  // branch production actually takes. It previously synthesized TaskSpecs from
  // bare event taskIds and emitted required:true with empty dependency and
  // producedArtifact arrays — invented defaults in the same unlabelled shape as
  // ledger-derived fields, which a UI would render as observed runtime truth.
  let lifecycle: Awaited<ReturnType<typeof runTravelLifecycle>>;
  let withDescriptor: NonNullable<ReturnType<typeof buildGovernedRunView>>;
  let withoutDescriptor: NonNullable<ReturnType<typeof buildGovernedRunView>>;

  beforeAll(async () => {
    lifecycle = await runTravelLifecycle("travel-descriptorless-run");
    withDescriptor = buildGovernedRunView(
      lifecycle.store, lifecycle.runId, travelRunDescriptor(lifecycle.oracle))!;
    withoutDescriptor = buildGovernedRunView(lifecycle.store, lifecycle.runId)!;
  });

  afterAll(async () => { await lifecycle.cleanup(); });

  it("still reports ledger-observed task identity and derived status", () => {
    expect(withoutDescriptor.tasks.length).toBeGreaterThan(0);
    const task = withoutDescriptor.tasks.find((item) => item.taskId === T4_IDENTITY)!;
    expect(task.taskId).toBe(T4_IDENTITY);
    expect(task.status).toBe("COMPLETED");
  });

  it("REGRESSION: never invents graph shape it did not observe", () => {
    for (const task of withoutDescriptor.tasks) {
      for (const field of ["label", "required", "dependencies", "producedArtifacts"] as const) {
        expect(task[field].quality).toBe("UNAVAILABLE");
        expect(task[field].value).toBeNull();
        expect(task[field].source).toBe("NONE");
      }
    }
  });

  it("REGRESSION: does not claim tasks are required, nor that they have no dependencies", () => {
    const task = withoutDescriptor.tasks.find((item) => item.taskId === T4_IDENTITY)!;
    // The old contract emitted `required: true` and `{tasks: [], artifacts: []}`
    // here, both of which the backend never observed.
    expect(task.required.value).not.toBe(true);
    expect(task.dependencies.value).not.toEqual({ tasks: [], artifacts: [] });
  });

  it("labels the same fields DECLARED — never OBSERVED — when a descriptor IS supplied", () => {
    const task = withDescriptor.tasks.find((item) => item.taskId === T4_IDENTITY)!;
    for (const field of ["label", "required", "dependencies", "producedArtifacts"] as const) {
      expect(task[field].quality).toBe("DECLARED");
      expect(task[field].source).toBe("WORKLOAD_DESCRIPTOR");
    }
    expect(task.dependencies.value?.artifacts.length).toBeGreaterThan(0);
  });

  it("omits the workload's self-verdict entirely when no descriptor is supplied", () => {
    expect(withoutDescriptor.outcome.domain).toBeNull();
    expect(withoutDescriptor.outcome.governanceOracle).toBeNull();
    expect(withoutDescriptor.run.workload).toBeNull();
    // ...while the ledger-derived half is still present and labelled.
    expect(withoutDescriptor.outcome.runtime.quality).toBe("DERIVED");
  });

  it("REGRESSION: derives usage-to-routing correlation instead of asserting it", () => {
    expect(withoutDescriptor.usageFeedback.laterDecisionsReferenceProjectedState.quality).toBe("DERIVED");
    expect(withoutDescriptor.usageFeedback.laterDecisionsReferenceProjectedState.value).toBe(true);
    // Proven derived, not literal: an empty ledger cannot satisfy it.
    const emptyRun = buildGovernedRunView(lifecycle.store, "no-such-run");
    expect(emptyRun).toBeNull();
  });
});
