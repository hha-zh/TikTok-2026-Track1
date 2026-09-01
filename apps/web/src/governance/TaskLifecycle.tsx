import { taskPresentation } from "./presentation";
import type { GovernedTask } from "./types";

export function TaskLifecycle({ tasks, selectedTaskId, onSelect }: {
  tasks: GovernedTask[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  return (
    <section className="governance-card lifecycle-card">
      <div className="governance-card-heading"><span>Observed lifecycle</span></div>
      {tasks.length === 0 ? <p className="governance-unavailable">No task lifecycle evidence is available yet.</p> : (
        <div className="task-lifecycle" role="list" aria-label="Observed governed tasks">
          {tasks.map((task) => {
            const presentation = taskPresentation(task);
            return (
            <button
              key={task.taskId}
              type="button"
              role="listitem"
              className={`lifecycle-task lifecycle-${task.status.toLowerCase()} ${selectedTaskId === task.taskId ? "selected" : ""}`}
              aria-pressed={selectedTaskId === task.taskId}
              onClick={() => onSelect(task.taskId)}
            >
              <span className="lifecycle-state" aria-hidden="true"><span className="lifecycle-dot" /></span>
              <strong>{presentation.label}</strong>
            </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
