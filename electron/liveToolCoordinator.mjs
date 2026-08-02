export function normalizeToolResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("ok" in value || "status" in value || "error" in value) return value;
    return { ok: true, status: "ok", data: value };
  }
  return { ok: true, status: "ok", data: value ?? null };
}

export class LiveToolCoordinator {
  constructor() {
    this.chain = Promise.resolve();
    this.cancelledIds = new Set();
  }

  cancel(ids = []) {
    for (const id of ids) {
      if (id) this.cancelledIds.add(String(id));
    }
    while (this.cancelledIds.size > 1000) {
      this.cancelledIds.delete(this.cancelledIds.values().next().value);
    }
  }

  enqueue(toolCall, { execute, onCall, send, isCancelled, survivesCancellation }) {
    const operation = this.chain.then(async () => {
      const calls = toolCall?.functionCalls || [];
      const functionResponses = [];
      try {
        for (const call of calls) {
          const id = call?.id ? String(call.id) : "";
          const cancelled = () =>
            Boolean(id) &&
            (this.cancelledIds.has(id) || isCancelled?.(id));
          const name = String(call?.name || "");
          const args = call?.args && typeof call.args === "object" ? call.args : {};
          // Speaking over Gemini cancels its turn and every tool call still in
          // flight. Dropping those is usually right — they answer a question
          // nobody is asking any more. A call that stages state the rest of the
          // conversation refers to is the exception: skipping it leaves the
          // model certain it staged something the app never recorded.
          if (cancelled() && !survivesCancellation?.(name)) continue;
          onCall?.({ id, name, args });
          let result;
          try {
            result = normalizeToolResult(await execute(name, args));
          } catch (error) {
            result = {
              ok: false,
              status: "error",
              error: error?.message || String(error),
            };
          }
          // A cancelled call has no place left in the protocol for its answer.
          if (cancelled()) continue;
          functionResponses.push({
            ...(id ? { id } : {}),
            name,
            response: { result },
          });
        }
        if (functionResponses.length) await send(functionResponses);
        return functionResponses;
      } finally {
        for (const call of calls) {
          if (call?.id) this.cancelledIds.delete(String(call.id));
        }
      }
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
