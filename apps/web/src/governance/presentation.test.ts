import { describe, expect, it } from "vitest";
import { modeLabel, placementLabel, taskPresentation } from "./presentation";
import type { GovernedTask } from "./types";

const task = (label: GovernedTask["label"]): GovernedTask => ({
  taskId: "technical_task_id",
  status: "READY",
  statusQuality: "DERIVED",
  label,
  required: { value: null, quality: "UNAVAILABLE", source: "NONE" },
  dependencies: { value: null, quality: "UNAVAILABLE", source: "NONE" },
  producedArtifacts: { value: null, quality: "UNAVAILABLE", source: "NONE" },
  executionProvenance: { value: null, quality: "UNAVAILABLE" },
});

describe("governance presentation", () => {
  it("keeps an unavailable label unavailable instead of humanizing the task id", () => {
    expect(taskPresentation(task({ value: null, quality: "UNAVAILABLE", source: "NONE" })))
      .toEqual({ label: "Unavailable", technicalId: "technical_task_id", labelQuality: "UNAVAILABLE" });
  });

  it("preserves a declared label and its quality", () => {
    expect(taskPresentation(task({ value: "Verify identity", quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" })))
      .toEqual({ label: "Verify identity", technicalId: "technical_task_id", labelQuality: "DECLARED" });
  });

  it("maps only recorded runtime enums to neutral display labels", () => {
    expect(placementLabel("DELEGATE_SPECIALIST")).toBe("Delegated to specialist");
    expect(placementLabel("REUSE_CURRENT")).toBe("Reused current agent");
    expect(modeLabel("PARALLEL")).toBe("Parallel execution");
  });
});
