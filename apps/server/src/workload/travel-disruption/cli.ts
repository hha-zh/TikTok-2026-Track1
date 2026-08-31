import { runTravelLifecycle, travelLifecyclePassed } from "./run.js";

const lifecycle = await runTravelLifecycle();
try {
  const lines = [
    "Travel disruption lifecycle (deterministic fixture)",
    `Outcome: ${lifecycle.engine.outcome}`,
    `Tasks completed: ${lifecycle.engine.progress.completed.size}/7`,
    `Delegated tasks: ${lifecycle.delegation.records.map((item) => item.taskId).join(", ")}`,
    `Delegated grants terminal: ${lifecycle.revokedGrantIds.length}/${lifecycle.delegation.records.length} revoked`,
    `Root protected-resource denial: ${lifecycle.oracle.governance.exactRootDenial ? "PASS (NOT_EXERCISABLE_DELEGATE_ONLY)" : "FAIL"}`,
    `Protected value absent from evidence: ${lifecycle.oracle.governance.passportBackendOnly ? "PASS" : "FAIL"}`,
    `Early independent work: ${lifecycle.oracle.adaptive.earlyRouterTopology ? "PARALLEL DELEGATION" : "FAILED"}`,
    `Later validation topology: ${lifecycle.oracle.adaptive.freshStateChangesWho ? "REUSE CURRENT" : "FAILED"}`,
    `Final plan: ${lifecycle.oracle.domain.approvalRequired ? "READY FOR APPROVAL" : "MISSING"}`,
    `Oracle: ${travelLifecyclePassed(lifecycle) ? "PASS" : "FAIL"}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  if (!travelLifecyclePassed(lifecycle)) process.exitCode = 1;
} finally {
  await lifecycle.cleanup();
}
