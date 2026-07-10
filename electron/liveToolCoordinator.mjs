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
  }

  enqueue(toolCall, { execute, onCall, send }) {
    const operation = this.chain.then(async () => {
      const functionResponses = [];
      for (const call of toolCall?.functionCalls || []) {
        const name = String(call?.name || "");
        const args = call?.args && typeof call.args === "object" ? call.args : {};
        onCall?.({ name, args });
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
        functionResponses.push({
          ...(call?.id ? { id: call.id } : {}),
          name,
          response: { result },
        });
      }
      if (functionResponses.length) await send(functionResponses);
      return functionResponses;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
