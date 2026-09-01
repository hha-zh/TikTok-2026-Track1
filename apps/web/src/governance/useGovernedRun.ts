import { useCallback, useEffect, useMemo, useState } from "react";
import { getGovernedRun } from "./api";
import type { GovernedRunView } from "./types";

export function useGovernedRun(runId: string, principalId: string, enabled: boolean, pollingMs = 2_000) {
  const [run, setRun] = useState<GovernedRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const fetchTarget = useCallback(async (targetRunId: string, targetPrincipalId: string, clearExisting: boolean) => {
    if (!targetRunId.trim() || !targetPrincipalId.trim()) return;
    if (clearExisting) {
      setRun(null);
      setSelectedTaskId(null);
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getGovernedRun(targetRunId.trim(), targetPrincipalId.trim());
      setRun(result.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(() => fetchTarget(runId, principalId, true), [fetchTarget, principalId, runId]);
  const refresh = useCallback(() => fetchTarget(runId, principalId, false), [fetchTarget, principalId, runId]);
  const bind = useCallback(
    (targetRunId: string, targetPrincipalId: string) =>
      fetchTarget(targetRunId, targetPrincipalId, true),
    [fetchTarget],
  );
  const clear = useCallback(() => {
    setRun(null);
    setSelectedTaskId(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled || !run || run.run.status !== "RUNNING") return;
    const timer = window.setInterval(() => void refresh(), pollingMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollingMs, refresh, run]);

  const observedTasks = useMemo(() => {
    if (!run) return [];
    const observedIds = new Set(
      run.governanceEvents.flatMap((event) => event.taskId ? [event.taskId] : []),
    );
    return run.tasks.filter((task) => observedIds.has(task.taskId));
  }, [run]);

  useEffect(() => {
    if (observedTasks.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    setSelectedTaskId((current) =>
      current && observedTasks.some((task) => task.taskId === current)
        ? current
        : observedTasks[0]!.taskId,
    );
  }, [observedTasks]);

  const selectedTask = observedTasks.find((task) => task.taskId === selectedTaskId) ?? null;

  return { run, loading, error, load, bind, clear, refresh, observedTasks, selectedTask, selectedTaskId, setSelectedTaskId };
}
