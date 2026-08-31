import { useState } from "react";
import { GovernanceRail } from "./GovernanceRail";
import { RunSafeguards } from "./RunSafeguards";
import { RunPressureBar } from "./RunPressureBar";
import { TaskGovernanceDetail } from "./TaskGovernanceDetail";
import { TaskLifecycle } from "./TaskLifecycle";
import { useGovernedRun } from "./useGovernedRun";
import "./governance.css";

export function GovernanceInspector({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [runId, setRunId] = useState("");
  const [principalId, setPrincipalId] = useState("");
  const controller = useGovernedRun(runId, principalId, open);

  if (!open) return <GovernanceRail open={false} onToggle={onToggle} />;

  return (
    <aside id="runtime-governance-inspector" className="governance-inspector" aria-label="Runtime Governance Inspector">
      <header className="governance-header">
        <div className="governance-title">
          <span className="governance-shield" aria-hidden="true">◇</span>
          <div><strong>Runtime governance</strong><span>{controller.run?.run.status ?? "Read-only inspector"}</span></div>
        </div>
        <button type="button" onClick={onToggle} aria-label="Collapse Governance">›</button>
      </header>

      <form className="governance-connect" onSubmit={(event) => { event.preventDefault(); void controller.load(); }}>
        <label>Governed run ID<input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="Enter an existing run ID" required /></label>
        <label>Development principal<input value={principalId} onChange={(event) => setPrincipalId(event.target.value)} placeholder="Human principal ID" required /></label>
        <button type="submit" disabled={controller.loading}>{controller.loading ? "Loading…" : controller.run ? "Refresh evidence" : "Inspect run"}</button>
        <p>This principal is an explicit local-development selector, not authenticated identity.</p>
      </form>

      <div className="governance-content" aria-live="polite">
        {controller.loading && !controller.run && <div className="governance-shell-state"><span className="spinner" />Loading governed evidence…</div>}
        {controller.error && <div className="governance-error" role="alert"><strong>Unable to load evidence</strong><span>{controller.error}</span></div>}
        {!controller.loading && !controller.run && !controller.error && <div className="governance-shell-state governance-empty"><span>◇</span><strong>No run selected</strong><p>Enter a governed run ID. Ordinary Agent run IDs are not interchangeable.</p></div>}
        {controller.run && <>
          <section className="governance-run-summary">
            <div><span>Run</span><strong>{controller.run.run.runId}</strong></div>
            <div><span>Workload</span><strong>{controller.run.run.workload?.scenario ?? "Unavailable"}</strong></div>
          </section>
          <RunPressureBar budget={controller.run.runtimeState.budgetHorizon} />
          <RunSafeguards events={controller.run.governanceEvents} />
          <TaskLifecycle tasks={controller.observedTasks} selectedTaskId={controller.selectedTaskId} onSelect={controller.setSelectedTaskId} />
          {controller.selectedTask
            ? <TaskGovernanceDetail task={controller.selectedTask} run={controller.run} />
            : <section className="governance-card"><p className="governance-unavailable">Selected-task evidence is unavailable until a task appears in the governed read model.</p></section>}
        </>}
      </div>
    </aside>
  );
}
