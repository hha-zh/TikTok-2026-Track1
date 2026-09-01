import type { GovernedTask } from "./types";

export function taskPresentation(task: GovernedTask) {
  return {
    label: task.label.value ?? "Unavailable",
    technicalId: task.taskId,
    labelQuality: task.label.quality,
  };
}

export function placementLabel(placement: string | null): string {
  if (placement === "DELEGATE_SPECIALIST") return "Delegated to specialist";
  if (placement === "REUSE_CURRENT") return "Reused current agent";
  return placement ?? "Unavailable";
}

export function modeLabel(shape: string): string {
  if (shape === "PARALLEL") return "Parallel execution";
  if (shape === "SERIAL") return "Serial execution";
  if (shape === "DIRECT") return "Direct execution";
  return shape;
}
