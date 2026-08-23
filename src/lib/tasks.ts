import type { TaskCard, TaskStep } from "../types";

export const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error"]);

export function isActiveTask(task: TaskCard): boolean {
  return !TERMINAL.has(task.status.toLowerCase());
}

export function tasksForSession(
  tasks: TaskCard[],
  sessionId: string | null,
  showAll = false,
): TaskCard[] {
  if (showAll) return tasks;
  if (!sessionId) return [];
  return tasks.filter((task) => task.sessionId === sessionId);
}

// Suppresses WorkCard's inline "Approval required" box for the task that is
// already shown as the full-screen ApprovalPrompt modal, so the same
// approval never renders twice at once.
export function shouldRenderInlineApproval(
  taskId: string,
  pendingApprovalTaskId: string | null,
): boolean {
  return taskId !== pendingApprovalTaskId;
}

export function taskKeyFor(task: string): string {
  return `starting:${task.toLowerCase().trim()}`;
}

// Stable key for the transient "mission accepted" stamp. Keyed by task text so it
// survives Hermes swapping the placeholder card for the real run_id card.
export function acceptedKey(task: string): string {
  return task.toLowerCase().trim();
}

export function shortRunId(id: string): string {
  if (!id || id === "pending") return "pending";
  if (id.startsWith("starting:")) return "starting";
  if (id.startsWith("history:")) return "restored";
  if (id.length <= 14) return id;
  return `${id.slice(0, 7)}…${id.slice(-5)}`;
}

export function normalizeMarkdown(text?: string): string {
  if (!text) return "";
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ");
}

export type ToolCategory = "browser" | "search" | "code" | "file" | "tool";

export function toolCategory(tool: string): ToolCategory {
  const t = tool.toLowerCase();
  if (t.includes("search")) return "search";
  if (t.includes("browser") || t.includes("navigate") || t.includes("fetch") || t.includes("web") || t.includes("url"))
    return "browser";
  if (
    t.includes("code") ||
    t.includes("python") ||
    t.includes("shell") ||
    t.includes("bash") ||
    t.includes("exec") ||
    t.includes("terminal") ||
    t.includes("command") ||
    t.includes("run")
  )
    return "code";
  if (t.includes("file") || t.includes("read") || t.includes("write") || t.includes("edit") || t.includes("patch"))
    return "file";
  return "tool";
}

export function prettyToolName(tool: string): string {
  return tool.replace(/[_.]+/g, " ").trim();
}

function hostFromUrl(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function baseName(value?: string): string {
  if (!value) return "";
  const cleaned = value.split(/[?#]/)[0].replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Short secondary detail for a tool step: a host for URLs, a filename for file
// tools, or a trimmed single-line snippet for code/other tools.
export function stepDetail(step: TaskStep): string {
  if (!step.preview) return "";
  const category = toolCategory(step.tool);
  if (category === "browser" || category === "search") {
    return hostFromUrl(step.preview) || step.preview.slice(0, 60);
  }
  if (category === "file") {
    return baseName(step.preview) || step.preview.slice(0, 48);
  }
  const oneLine = step.preview.replace(/\s+/g, " ").trim();
  return oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine;
}

// One-line "what Hermes is doing right now" headline for an active step.
export function stepHeadline(step: TaskStep): string {
  const category = toolCategory(step.tool);
  const detail = stepDetail(step);
  if (category === "browser") return detail ? `Browsing ${detail}` : "Browsing the web";
  if (category === "search") return detail ? `Searching ${detail}` : "Searching the web";
  if (category === "code") return "Running code";
  if (category === "file") return detail ? `Working on ${detail}` : "Working with files";
  return `Using ${prettyToolName(step.tool)}`;
}

export function eventTime(event: SidecarEvent): number {
  return typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now();
}

export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function readStatusObject(value: unknown): {
  running?: boolean;
  pid?: number | null;
  model?: string;
  mode?: string;
} {
  if (!value || typeof value !== "object") return {};
  return value as { running?: boolean; pid?: number | null; model?: string; mode?: string };
}

// ===== Fuzzy voice-query task matching =====

const QUERY_STOP_WORDS = new Set([
  "open",
  "show",
  "me",
  "the",
  "a",
  "an",
  "one",
  "task",
  "card",
  "result",
  "latest",
  "current",
]);

const QUERY_SYNONYMS: Record<string, string> = {
  herems: "hermes",
  herme: "hermes",
  pakage: "package",
  pkg: "package",
  fialed: "failed",
  fail: "failed",
  errored: "failed",
  error: "failed",
  hands: "hand",
  hadn: "hand",
  deisgn: "design",
  desing: "design",
};

function normalizeQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => QUERY_SYNONYMS[token] ?? token)
    .filter((token) => !QUERY_STOP_WORDS.has(token));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function fuzzyTokenMatch(queryToken: string, candidateToken: string): boolean {
  if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) return true;
  if (queryToken.length < 4 || candidateToken.length < 4) return false;
  const maxDistance = Math.min(queryToken.length, candidateToken.length) >= 6 ? 2 : 1;
  return editDistance(queryToken, candidateToken) <= maxDistance;
}

export function findTaskMatches(
  sortedTasks: TaskCard[],
  query?: string,
): Array<{ task: TaskCard; score: number }> {
  const queryTokens = normalizeQuery(query ?? "");
  if (!queryTokens.length) return [];

  const scored: Array<{ task: TaskCard; score: number }> = [];
  for (const task of sortedTasks) {
    const haystack = `${task.task} ${task.status} ${task.id}`;
    const candidateTokens = normalizeQuery(haystack);
    let score = 0;

    for (const token of queryTokens) {
      const exact = candidateTokens.includes(token);
      const fuzzy = exact || candidateTokens.some((candidate) => fuzzyTokenMatch(token, candidate));
      if (exact) score += 4;
      else if (fuzzy) score += 2;
    }

    if ((task.output || task.error) && score > 0) score += 2;
    if (task.status.toLowerCase() === "failed" && queryTokens.includes("failed")) score += 6;
    if (!TERMINAL.has(task.status.toLowerCase())) score -= 1;

    if (score > 0) scored.push({ task, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt)
    .slice(0, 3);
}
