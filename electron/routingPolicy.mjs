const UI =
  /\b(open|close|show|hide|expand|collapse|enter|exit|focus|filter)\b.*\b(result|task|steps|history|hud|overlay|brain|map|note)\b|\b(hud|overlay|brain|map)\s+mode\b/i;
const MEMORY =
  /\b(remember|memory|what do (?:we|you) know|what did i|have i|my (?:preference|client|deal|draft|project)|previously|last time|the usual)\b/i;
const CURRENT_WEB =
  /\b(latest|today|current|right now|news|weather|score|price|stock|who is|when is)\b/i;
const ACTION =
  /\b(build|create|write|edit|fix|research|investigate|compare|check|send|email|book|buy|download|upload|analyze|analyse|summarize|summarise|automate|run|deploy|organize|organise|update|delete|file|code)\b/i;
const GREETING = /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you)[!. ]*$/i;

export function classifyRoute(text) {
  const value = String(text || "").trim();
  if (!value || GREETING.test(value)) return "direct";
  if (UI.test(value)) return "ui";
  if (MEMORY.test(value)) return "memory";
  if (ACTION.test(value)) return "hermes";
  if (CURRENT_WEB.test(value)) return "web";
  return "direct";
}

export function routingGuidance(route) {
  return {
    direct: "Answer briefly without tools unless factual uncertainty requires search.",
    web: "Use Google Search for a lightweight current/public fact.",
    memory: "Use search_memory, then read_memory_note for detailed facts.",
    hermes: "Stage a structured Hermes proposal and require explicit confirmation.",
    ui: "Use get_iris_ui_context and control_iris_ui; never delegate UI-only work.",
  }[route] || "";
}
