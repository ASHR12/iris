export async function readStoredHermesResult({
  runId,
  uiContext = {},
  registry,
  fetchHistory,
}) {
  const requestedId = String(
    runId ||
      uiContext.expandedTaskId ||
      uiContext.focusedTaskId ||
      uiContext.latestResultTaskId ||
      "",
  ).trim();
  if (!requestedId) {
    return {
      ok: false,
      error: "No Hermes task is selected or available.",
      instructions: "Say that no task result is currently selected; do not guess.",
    };
  }

  const persisted = registry?.get?.(requestedId);
  if (persisted && (persisted.output || persisted.error)) {
    return {
      ok: true,
      run_id: requestedId,
      task: persisted.task,
      status: persisted.status,
      output: persisted.output || persisted.error,
      instructions: "Answer only from this complete Hermes result.",
    };
  }

  const history = await fetchHistory();
  const task = history?.ok
    ? history.tasks?.find((item) => item.id === requestedId)
    : null;
  if (!task || !(task.output || task.error)) {
    return {
      ok: false,
      run_id: requestedId,
      error: "The selected Hermes result could not be restored.",
      instructions: "Say the result is unavailable; do not invent its contents.",
    };
  }
  return {
    ok: true,
    run_id: requestedId,
    task: task.task,
    status: task.status,
    output: task.output || task.error,
    instructions: "Answer only from this complete Hermes result.",
  };
}
