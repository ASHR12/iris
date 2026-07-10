export type ReactorState = "idle" | "online" | "listening" | "speaking" | "working";

// One Hermes tool invocation, surfaced live from the SSE event stream.
export type TaskStep = {
  id: string;
  tool: string;
  preview?: string;
  status: "running" | "done" | "error";
  duration?: number;
  ts: number;
};

export type TaskApproval = {
  command?: string;
  reason?: string;
  choices: Array<"once" | "session" | "always" | "deny">;
  requestedAt: number;
  resolving?: boolean;
  error?: string;
};

export type HermesInteraction = {
  id: string;
  type: "clarify" | "approval" | "sudo" | "secret";
  question: string;
  choices: string[];
  command?: string;
  envVar?: string;
  allowCustom: boolean;
  secret: boolean;
  resolving?: boolean;
  error?: string;
  voiceValue?: string;
  voiceSubmitting?: boolean;
};

export type TaskCard = {
  id: string;
  sessionId?: string;
  task: string;
  status: string;
  output?: string;
  error?: string;
  updatedAt: number;
  steps?: TaskStep[];
  notes?: string;
  approval?: TaskApproval | null;
  interaction?: HermesInteraction | null;
};

export type LogLine = {
  id: string;
  level: string;
  message: string;
  timestamp: number;
};

export type TranscriptLine = {
  id: string;
  speaker: string;
  text: string;
};

// Purely-visual delegation handoff effects (orb <-> Work Stream). These never
// touch task/voice logic; they only react to changes in the tasks array.
export type HandoffTone = "amber" | "success" | "error";

export type Pulse = {
  id: string;
  kind: "out" | "in";
  tone: HandoffTone;
  fromX: number;
  fromY: number;
  dx: number;
  dy: number;
  lift: number;
  angle: number;
};
