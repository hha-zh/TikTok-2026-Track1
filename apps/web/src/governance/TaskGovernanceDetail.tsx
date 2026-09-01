import { AuthorityCard } from "./AuthorityCard";
import { ContextProjectionCard } from "./ContextProjectionCard";
import { DelegationScopeCard } from "./DelegationScopeCard";
import { EvidenceBadge } from "./EvidenceBadge";
import { ReturnGatePanel } from "./ReturnGatePanel";
import { modeLabel, placementLabel, taskPresentation } from "./presentation";
import type { GovernedRunView, GovernedTask, RoutingDecision } from "./types";

function RuntimeDecisionCard({ decision }: { decision: RoutingDecision | null }) {
  return (
    <section className="governance-card decision-card">
      <div className="governance-card-heading"><span>Runtime decision</span><EvidenceBadge quality={decision ? "OBSERVED" : "UNAVAILABLE"} /></div>
      {!decision ? <p className="governance-unavailable">No routing decision is recorded for this task.</p> : <>
        <strong className="decision-result">{placementLabel(decision.who)}</strong>
        <span>{modeLabel(decision.how)} · {decision.disposition}</span>
        <dl>
          <div><dt>Run tokens remaining</dt><dd>{decision.horizon.runTokensRemaining.toLocaleString()}</dd></div>
          <div><dt>Child slots remaining</dt><dd>{decision.horizon.childSlotsRemaining}</dd></div>
          <div><dt>Wave</dt><dd>{decision.wave ?? "Unavailable"}</dd></div>
        </dl>
        <div className="decision-explanation"><span>Explanation</span><EvidenceBadge quality="UNAVAILABLE" /></div>
      </>}
    </section>
  );
}

export function TaskGovernanceDetail({ task, run }: { task: GovernedTask; run: GovernedRunView }) {
  const decisions = run.routingDecisions.filter((item) => item.taskId === task.taskId);
  const decision = decisions.at(-1) ?? null;
  const taskEvents = run.governanceEvents.filter((event) => event.taskId === task.taskId);
  const delegations = run.delegations.filter((item) => item.taskId === task.taskId);
  const projections = run.contextProjections.filter((item) => item.taskId === task.taskId);
  const artifacts = run.artifacts.filter((artifact) => artifact.taskId === task.taskId);
  const presentation = taskPresentation(task);
  return (
    <div className="task-governance-detail">
      <section className="selected-task-heading">
        <div><span>Selected task</span><h3>{presentation.label}</h3><code>{presentation.technicalId}</code></div>
        <EvidenceBadge quality={presentation.labelQuality} />
        <small>{task.status} · status {task.statusQuality}</small>
      </section>
      <RuntimeDecisionCard decision={decision} />
      <AuthorityCard events={taskEvents} delegations={delegations} />
      <DelegationScopeCard delegations={delegations} />
      <ContextProjectionCard projections={projections} />
      <ReturnGatePanel artifacts={artifacts} />
    </div>
  );
}
