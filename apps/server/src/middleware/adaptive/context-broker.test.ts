import { describe, expect, it } from "vitest";
import type { Envelope, GovernanceState } from "../governance/types.js";
import {
  PARENT_EXERCISABLE_ACTIONS,
  PARENT_EXERCISABLE_RESOURCES,
} from "../governance/fixtures.js";
import { projectContext, type ContextArtifact } from "./context-broker.js";
import { deriveExecutionEnvelope } from "./execution-envelope.js";
import { task } from "./task-graph.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PARENT = "agent-parent";
const CHILD = "agent-child";

function envelopeFor(principalId: string, grantId: string): Envelope {
  return {
    id: grantId,
    principalId,
    exercisable: {
      resources: [...PARENT_EXERCISABLE_RESOURCES],
      actions: [...PARENT_EXERCISABLE_ACTIONS],
    },
    delegatable: { resources: [], actions: [] },
    depth: 1,
    maxTokens: 12_000,
    maxToolCalls: 40,
    maxChildren: 2,
    runId: "run-1",
    createdAt: NOW,
  };
}

function stateFor(principalId: string, grantId: string): GovernanceState {
  return {
    envelope: envelopeFor(principalId, grantId),
    ancestry: [],
    grantState: { grantId, revoked: false, tokensUsed: 0, childCount: 0 },
    runState: { runId: "run-1", maxTokens: 12_000, tokensUsed: 0 },
    now: NOW,
  };
}

const viewFor = (principalId: string, grantId: string, spec: ReturnType<typeof task>) =>
  deriveExecutionEnvelope({ state: stateFor(principalId, grantId), task: spec });

const ownOutput = (id: string, principalId: string, value: unknown): ContextArtifact => ({
  id,
  origin: "own_task_output",
  producedByPrincipalId: principalId,
  value,
});

const published = (
  id: string,
  producedBy: string,
  recipients: string[],
  value: unknown,
): ContextArtifact => ({
  id,
  origin: "published_finding",
  producedByPrincipalId: producedBy,
  recipients,
  artifactType: "SecurityFinding",
  value,
});

describe("ContextBroker", () => {
  it("includes a required artifact the executor produced itself", () => {
    const spec = task({ id: "plan", requiredArtifacts: ["workspace_summary"] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), [
      ownOutput("workspace_summary", PARENT, { files: 12 }),
    ]);
    expect(projection.included).toEqual([
      { id: "workspace_summary", origin: "own_task_output", value: { files: 12 } },
    ]);
    expect(projection.missingRequired).toEqual([]);
  });

  it("withholds everything the task does not require", () => {
    // Least context by default, not by remembering to filter.
    const spec = task({ id: "plan", requiredArtifacts: ["workspace_summary"] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), [
      ownOutput("workspace_summary", PARENT, { files: 12 }),
      ownOutput("unrelated_notes", PARENT, { secret: "not for this task" }),
    ]);
    expect(projection.included.map((item) => item.id)).toEqual(["workspace_summary"]);
    expect(projection.withheld).toContainEqual({
      id: "unrelated_notes",
      reason: "NOT_REQUIRED",
      detail: "committed, but this task does not require it",
    });
  });

  it("never lets a child's raw output reach the parent", () => {
    // The boundary the Return Gate exists for. A child's own task output is
    // visible only to the child; the parent is a different principal.
    const spec = task({ id: "review", requiredArtifacts: ["audit_notes"] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), [
      ownOutput("audit_notes", CHILD, { rows: ["rmenon exported 47 records"] }),
    ]);
    expect(projection.included).toEqual([]);
    expect(projection.missingRequired).toEqual(["audit_notes"]);
    expect(projection.withheld[0]?.reason).toBe("NOT_VISIBLE_TO_EXECUTOR");
    expect(projection.withheld[0]?.detail).toContain("Return Gate");
  });

  it("briefs a child with what its parent produced", () => {
    // Downward is not declassification: the parent already holds the value and
    // the child is strictly narrower.
    const spec = task({ id: "plan", requiredArtifacts: ["workspace_summary"] });
    const projection = projectContext(
      spec,
      viewFor(CHILD, "grant-child", spec),
      [ownOutput("workspace_summary", PARENT, { files: 12 })],
      [PARENT],
    );
    expect(projection.included.map((item) => item.id)).toEqual(["workspace_summary"]);
  });

  it("still refuses a sibling's output even with an ancestry supplied", () => {
    const spec = task({ id: "plan", requiredArtifacts: ["sibling_notes"] });
    const projection = projectContext(
      spec,
      viewFor(CHILD, "grant-child", spec),
      [ownOutput("sibling_notes", "agent-sibling", { secret: true })],
      [PARENT],
    );
    // A sibling is in neither line.
    expect(projection.included).toEqual([]);
    expect(projection.withheld[0]?.reason).toBe("NOT_VISIBLE_TO_EXECUTOR");
  });

  it("lets the same value through once it is published to the parent", () => {
    const spec = task({ id: "review", requiredArtifacts: ["finding"] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), [
      published("finding", CHILD, [PARENT], { verdict: "anomalous" }),
    ]);
    expect(projection.included).toEqual([
      { id: "finding", origin: "published_finding", value: { verdict: "anomalous" } },
    ]);
  });

  it("withholds a published artifact from a principal that is not a recipient", () => {
    const spec = task({ id: "review", requiredArtifacts: ["finding"] });
    const projection = projectContext(spec, viewFor("agent-sibling", "grant-sib", spec), [
      published("finding", CHILD, [PARENT], { verdict: "anomalous" }),
    ]);
    expect(projection.included).toEqual([]);
    expect(projection.withheld[0]?.reason).toBe("NOT_PUBLISHED_TO_EXECUTOR");
  });

  it("reports a required artifact that was never committed", () => {
    const spec = task({ id: "plan", requiredArtifacts: ["workspace_summary"] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), []);
    // The engine must not dispatch on this.
    expect(projection.missingRequired).toEqual(["workspace_summary"]);
    expect(projection.withheld[0]?.reason).toBe("NOT_AVAILABLE");
  });

  it("returns no verdict of any kind", () => {
    const spec = task({ id: "plan", requiredArtifacts: [] });
    const projection = projectContext(spec, viewFor(PARENT, "grant-parent", spec), []);
    const keys = Object.keys(projection);
    // It decides what to show, never whether the task may run.
    expect(keys).not.toContain("verdict");
    expect(keys).not.toContain("allowed");
    expect(keys).not.toContain("reason");
    expect(projection.sourceGrantId).toBe("grant-parent");
  });

  it("carries the executor identity the projection was built for", () => {
    const spec = task({ id: "plan", requiredArtifacts: [] });
    expect(
      projectContext(spec, viewFor(CHILD, "grant-child", spec), []).executorPrincipalId,
    ).toBe(CHILD);
  });
});
