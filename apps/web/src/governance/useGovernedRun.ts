import { useCallback, useEffect, useMemo, useState } from "react";
import { getGovernedRun } from "./api";
import type { GovernedRunView } from "./types";

export function useGovernedRun(runId: string, principalId: string, enabled: boolean) {
  const [run, setRun] = useState<GovernedRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const fetchRun = useCallback(async (clearExisting: boolean) => {
    if (!runId.trim() || !principalId.trim()) return;
    if (clearExisting) {
      setRun(null);
      setSelectedTaskId(null);
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getGovernedRun(runId.trim(), principalId.trim());
      setRun(result.run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [principalId, runId]);

  const load = useCallback(() => fetchRun(true), [fetchRun]);
  const refresh = useCallback(() => fetchRun(false), [fetchRun]);

  useEffect(() => {
    if (!enabled || !run || run.run.status !== "RUNNING") return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, run]);

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

  return { run, loading, error, load, refresh, observedTasks, selectedTask, selectedTaskId, setSelectedTaskId };
}
