import { useEffect, useState } from "react";
import { GovernanceRail } from "./GovernanceRail";
import { RunSafeguards } from "./RunSafeguards";
import { RunPressureBar } from "./RunPressureBar";
import { TaskGovernanceDetail } from "./TaskGovernanceDetail";
import { TaskLifecycle } from "./TaskLifecycle";
import { useGovernedRun } from "./useGovernedRun";
import type { GovernanceBinding } from "./travelDemo";
import "./governance.css";

export function GovernanceInspector({ open, onToggle, binding, bridgeError, resetKey }: {
  open: boolean;
  onToggle: () => void;
  binding: GovernanceBinding | null;
  bridgeError: string | null;
  resetKey: number;
}) {
  const [runId, setRunId] = useState("");
  const [principalId, setPrincipalId] = useState("");
  const [loaderOpen, setLoaderOpen] = useState(false);
  const autoBound = binding?.runId === runId && binding?.principalId === principalId;
  const controller = useGovernedRun(runId, principalId, open, autoBound ? 700 : 2_000);

  useEffect(() => {
    if (!binding) return;
    setRunId(binding.runId);
    setPrincipalId(binding.principalId);
    void controller.bind(binding.runId, binding.principalId);
  }, [binding?.principalId, binding?.runId, controller.bind]);

  useEffect(() => {
    if (resetKey > 0) controller.clear();
  }, [controller.clear, resetKey]);

  useEffect(() => {
    if (controller.run) setLoaderOpen(false);
  }, [controller.run]);

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

      <details className="governance-loader" open={loaderOpen} onToggle={(event) => setLoaderOpen(event.currentTarget.open)}>
        <summary>{controller.run ? "Change or reload run" : "Load run"}</summary>
        <form className="governance-connect" onSubmit={(event) => { event.preventDefault(); void controller.load(); }}>
          <label>Governed run ID<input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="Enter an existing run ID" /></label>
          <details className="development-access">
            <summary>Development access</summary>
            <label>Development principal<input value={principalId} onChange={(event) => setPrincipalId(event.target.value)} placeholder="Human principal ID" /></label>
            <p>This is an explicit local-development selector, not authenticated identity.</p>
          </details>
          <button type="submit" disabled={controller.loading || !runId.trim() || !principalId.trim()}>{controller.loading ? "Loading…" : controller.run ? "Reload evidence" : "Inspect run"}</button>
        </form>
      </details>

      <div className="governance-content" aria-live="polite">
        {controller.loading && !controller.run && <div className="governance-shell-state"><span className="spinner" />Loading governed evidence…</div>}
        {bridgeError && <div className="governance-error" role="alert"><strong>Governance demo unavailable</strong><span>{bridgeError}</span></div>}
        {controller.error && <div className="governance-error" role="alert"><strong>Unable to load evidence</strong><span>{controller.error}</span></div>}
        {!controller.loading && !controller.run && !controller.error && <div className="governance-shell-state governance-empty"><span>◇</span><strong>No governed run loaded.</strong><p>Use Load run for an existing governed run. Ordinary Agent run IDs are not interchangeable.</p></div>}
        {controller.run && <>
          <section className="governance-run-summary">
            <div><span>Current run</span><strong>{autoBound ? binding?.displayName ?? "Governed reference run" : controller.run.run.workload?.scenario ?? "Unavailable"}</strong></div>
            <div><span>Status</span><strong>{controller.run.run.status}</strong></div>
            <details className="run-technical-details"><summary>Technical details</summary><code>{controller.run.run.runId}</code></details>
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
