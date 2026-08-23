/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

type SidecarMode = "none" | "camera" | "screen";

type IrisWakeRequest = {
  source?: string;
  detail?: string;
};

type SidecarEvent = {
  type: string;
  timestamp?: number;
  [key: string]: unknown;
};

type LiveAudioChunk = {
  data: string;
  mimeType?: string;
};

type IrisUiAction = {
  action:
    | "open_latest_hermes_result"
    | "open_current_hermes_result"
    | "open_task"
    | "open_task_by_query"
    | "open_hermes_history"
    | "close_reader"
    | "close_history"
    | "close_all_overlays"
    | "show_task_steps"
    | "hide_task_steps"
    | "open_brain_graph"
    | "close_brain_graph"
    | "focus_brain_node"
    | "filter_brain_graph"
    | "open_brain_note"
    | "close_brain_note"
    | "show_full_brain_graph"
    | "enter_hud_mode"
    | "exit_hud_mode";
  target_id?: string;
  query?: string;
};

type IrisConfig = {
  geminiApiKey: string;
  geminiApiKeyConfigured: boolean;
  geminiModel: string;
  geminiVoice: string;
  hermesUrl: string;
  hermesKey: string;
  hermesKeyConfigured: boolean;
  hermesBin: string;
  hermesHome: string;
  hermesSession: string;
  brainPath: string;
  brainSemantic: boolean;
  brainAutoIndex: boolean;
  userName: string;
  loadTestData: boolean;
  wakeWord: boolean;
  wakeSensitivity: string;
  showWakeDiagnostics: boolean;
  sounds: boolean;
  autoSleepSeconds: string;
  autoWakeOnHermes: boolean;
  micDevice: string;
  cameraDevice: string;
  configured: boolean;
  voices: string[];
  models: string[];
  configPath: string;
  voiceDuplexMode: string;
  speakerEchoGuard: string;
};

type IrisTestResult = { ok: boolean; error?: string; health?: Record<string, unknown> };

type HermesHistoryTask = {
  id: string;
  sessionId?: string;
  task: string;
  status: string;
  output?: string;
  updatedAt: number;
  steps?: Array<{
    id: string;
    tool: string;
    preview?: string;
    status: "running" | "done" | "error";
    ts: number;
  }>;
  approval?: {
    command?: string;
    reason?: string;
    choices: Array<"once" | "session" | "always" | "deny">;
    requestedAt: number;
  } | null;
  interaction?: {
    id: string;
    type: "clarify" | "approval" | "sudo" | "secret";
    question: string;
    choices: string[];
    command?: string;
    envVar?: string;
    allowCustom: boolean;
    secret: boolean;
  } | null;
};

type HermesHistoryResult = {
  ok: boolean;
  tasks?: HermesHistoryTask[];
  sessions?: string[];
  error?: string;
};

type HermesSessionInfo = {
  id: string;
  source: string;
  title: string;
  preview: string;
  messageCount: number;
  lastActive: number;
};

type HermesSessionsResult = { ok: boolean; sessions: HermesSessionInfo[]; error?: string };

type BrainNode = {
  id: string;
  title: string;
  folder: string;
  degree: number;
};

type BrainLink = { source: string; target: string };

type BrainGraphResult = {
  ok: boolean;
  root?: string;
  nodes?: BrainNode[];
  links?: BrainLink[];
  error?: string;
};

type BrainNoteResult = {
  ok: boolean;
  meta?: Record<string, string>;
  body?: string;
  error?: string;
};

type BrainIndexSyncResult = {
  ok: boolean;
  total?: number;
  chunks?: number;
  embedded?: number;
  reused?: number;
  pruned?: number;
  ms?: number;
  model?: string;
  location?: string;
  error?: string;
};

type BrainFilterResult = {
  ok: boolean;
  mode?: "hybrid" | "lexical";
  results?: Array<{ path: string; title: string; folder: string }>;
  error?: string;
};

type BrainSearchResult = {
  ok: boolean;
  mode?: "hybrid" | "lexical";
  results?: Array<{
    path: string;
    title: string;
    folder: string;
    snippet: string;
    sources: string[];
    confident: boolean;
  }>;
  error?: string;
};

type IrisApi = {
  startSidecar: (options?: { mode?: SidecarMode }) => Promise<{ running: boolean; pid: number | null }>;
  stopSidecar: () => Promise<{ running: boolean; pid: number | null }>;
  getSidecarStatus: () => Promise<{ running: boolean; pid: number | null }>;
  getAppConfig: () => Promise<{
    loadTestData: boolean;
    sounds: boolean;
    userName: string;
    configured: boolean;
  }>;
  getConfig: () => Promise<IrisConfig>;
  saveConfig: (updates: Record<string, string>) => Promise<IrisConfig>;
  testGemini: (key?: string) => Promise<IrisTestResult>;
  testHermes: (payload?: { url?: string; key?: string }) => Promise<IrisTestResult>;
  previewVoice: (payload?: { voice?: string; key?: string }) => Promise<IrisTestResult>;
  getHermesHistory: () => Promise<HermesHistoryResult>;
  listHermesSessions: () => Promise<HermesSessionsResult>;
  createHermesSession: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  approveHermesAction: (
    runId: string,
    choice: "once" | "session" | "always" | "deny",
  ) => Promise<{ status: string; error?: string }>;
  respondHermesInteraction: (payload: {
    run_id: string;
    interaction_id: string;
    interaction_type: "clarify" | "approval" | "sudo" | "secret";
    value?: string;
    choice?: "once" | "session" | "always" | "deny";
  }) => Promise<{ status: string; error?: string }>;
  loadBrain: () => Promise<BrainGraphResult>;
  readBrainNote: (relPath: string) => Promise<BrainNoteResult>;
  searchBrain: (query: string, topK?: number) => Promise<BrainSearchResult>;
  filterBrain: (query: string) => Promise<BrainFilterResult>;
  syncBrainIndex: (payload?: { vault?: string; key?: string }) => Promise<BrainIndexSyncResult>;
  onBrainChanged: (callback: () => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  toggleHud: () => Promise<{ mode: "deck" | "hud" }>;
  setHudInteractive: (on: boolean) => void;
  onHudMode: (callback: (payload: { mode: "deck" | "hud" }) => void) => () => void;
  onWakeRequest: (callback: (request: IrisWakeRequest) => void) => () => void;
  onSleepRequest: (callback: () => void) => () => void;
  onAutoSleep: (callback: () => void) => () => void;
  sendCommand: (
    command: Record<string, unknown>,
  ) => Promise<{ ok: boolean; reason?: string }>;
  sendUiContext: (context: Record<string, unknown>) => void;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  notifyBootDone: () => void;
  reportVoiceState: (state: JarvisVoiceState) => void;
  askJarvis: (text: string) => Promise<JarvisAskResult>;
  getJarvisTasks: () => Promise<JarvisTasksResult>;
  getJarvisTopFocus: () => Promise<JarvisTopFocusResult>;
  getJarvisCurrentContext: () => Promise<JarvisCurrentContextResult>;
  getJarvisEngineeringJob: () => Promise<JarvisEngineeringJobResult>;
  getJarvisActiveGoal: () => Promise<JarvisActiveGoalResult>;
  getJarvisConnectionsStatus: () => Promise<JarvisConnectionsStatusResult>;
  proposeJarvisAction: (question: string, source?: "text" | "voice") => Promise<JarvisActionProposeResult>;
  approveJarvisAction: (previewId: string) => Promise<JarvisActionExecutionResult>;
  secondaryApproveJarvisAction: (previewId: string) => Promise<JarvisActionExecutionResult>;
  cancelJarvisAction: (previewId: string) => Promise<JarvisActionCancelResult>;
  onUiAction: (callback: (action: IrisUiAction) => void) => () => void;
  onAudioChunk: (callback: (chunk: LiveAudioChunk) => void) => () => void;
  onAudioInterrupt: (callback: () => void) => () => void;
  onSidecarEvent: (callback: (event: SidecarEvent) => void) => () => void;
};

// Iris Bridge — request/response contract for window.iris.askJarvis(text),
// reached via Iris's own main process (electron/jarvisBridgeClient.mjs),
// never a second parallel event bus.
type JarvisVoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";
type JarvisAskResult = { ok: boolean; answer?: string; error?: string };

// Jarvis Actions & Approvals (P2.5) — the whitelisted preview VIEW Jarvis's
// Action endpoint puts on the wire (Jarvis-Desktop/app/action-bridge-
// server.cjs toActionPreviewView). Display fields only: the live preview
// object, its execution context and every credential stay inside Jarvis's
// process. `previewId` is an opaque handle that is only ever meaningful to
// Jarvis's own Action Service — Iris stores no action state of its own.
type JarvisActionPreview = {
  previewId: string;
  domain: string;
  type: string;
  label: string;
  title: string;
  summary: string;
  riskLevel: string;
  requiresApproval: boolean;
  requiresSecondaryApproval: boolean;
  status: string;
  target: Record<string, unknown>;
  changes: Record<string, unknown>;
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  classification?: string;
  duplicate?: boolean;
};

// kind "none" means "this text is not an action" — the caller then falls
// through to the normal Ask Jarvis answer path.
type JarvisActionProposeResult = {
  ok: boolean;
  kind?: "preview" | "capture-preview" | "clarification" | "none" | "existing";
  previews?: JarvisActionPreview[];
  question?: string;
  error?: string;
};

// requiresSecondaryApproval:true means NOTHING was written yet — the action
// is waiting for the second, distinct approval.
type JarvisActionExecutionResult = {
  ok: boolean;
  requiresSecondaryApproval?: boolean;
  preview?: JarvisActionPreview;
  answer?: string;
  action?: string;
  object?: Record<string, unknown>;
  verified?: boolean;
  error?: string;
};

type JarvisActionCancelResult = { ok: boolean; cancelled?: boolean; error?: string };

// Personal OS bridge — verbatim field shapes from Jarvis's own
// personal-os-reader.cjs / daily-top-focus.cjs / daily-chief-of-staff.cjs
// (reached via getTasks/getTopFocus/getCurrentContext), never re-derived.
type JarvisTaskItem = {
  title: string;
  path: string;
  status: string;
  due: string;
  priority: string;
  project: string;
  area: string;
  overdue: boolean;
  dueToday: boolean;
  dueTomorrow: boolean;
  nextAction: string;
};

type JarvisWaitingItem = {
  title: string;
  path: string;
  status: "WAITING";
  waitingFor: string;
  since: string;
  followUp: string;
  followUpDue: boolean;
  project: string;
  expected: string;
};

type JarvisTasksResult = {
  ok: boolean;
  error?: string;
  data?: {
    now: JarvisTaskItem[];
    next: JarvisTaskItem[];
    waiting: JarvisWaitingItem[];
    overdue: JarvisTaskItem[];
  };
};

type JarvisTopFocusItem = {
  id: string;
  title: string;
  project: string | null;
  area: string | null;
  priority: string | null;
  whyNow: string;
  nextAction: string | null;
  deadline: string | null;
  blocker: string | null;
  tier: string;
};

type JarvisTopFocusResult = {
  ok: boolean;
  error?: string;
  data?: { top: JarvisTopFocusItem[] };
};

type JarvisNextAction = {
  id: string;
  source: string;
  kind: string;
  title: string;
  when: string | null;
  reason: string;
  blocked: boolean;
  blocker: string | null;
} | null;

type JarvisCurrentContextResult = {
  ok: boolean;
  error?: string;
  data?: {
    today: string;
    status: string;
    summary: {
      tasksOverdue: number;
      tasksDueToday: number;
      waitingFollowUpDue: number;
      decisionsOpen: number;
      projectsAttention: number;
    };
    recommended: JarvisNextAction;
  };
};

// Jarvis V1 Autonomy read surface — verbatim field shapes from
// Jarvis's own job-model.cjs/job-store.cjs/job-events.cjs/goal-store.cjs
// (reached via getLatestEngineeringJob/getActiveGoal), never re-derived.
// Promotion stops at ready_for_approval; there is no merge/push/promote
// control anywhere in Iris — read-only, same boundary as Jarvis's own
// CommandCenter.jsx AutonomyView.
type JarvisJobStatus =
  | "pending" | "scheduled" | "preparing" | "running" | "verifying"
  | "ready_for_approval" | "needs_human" | "completed" | "partial"
  | "failed" | "timeout" | "cancelled" | "not_configured";

type JarvisJobEvent = {
  timestamp: string;
  jobId: string;
  type: string;
  status: string;
  message: string;
  metadata: Record<string, unknown> | null;
};

type JarvisJobVerification = {
  result?: {
    actualChangedFiles?: string[];
    reportedChangedFiles?: string[];
    steps?: Array<{ name: string; passed: boolean; exitCode?: number }>;
    warnings?: string[];
    reasons?: string[];
  };
};

type JarvisJobPromotion = {
  commitHash?: string;
  actualChangedFiles?: string[];
  attempts?: number;
};

type JarvisEngineeringJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JarvisJobStatus;
  executionMode: string;
  task: string;
  source: string;
  workerKind: string | null;
  attemptCount: number | null;
  budgetState: { maxAttempts?: number; reason?: string } | null;
  verification: JarvisJobVerification | null;
  promotion: JarvisJobPromotion | null;
  metadata: { execution?: { branchName?: string; worktreePath?: string; baseRef?: string; preparedAt?: string } } | null;
  error: { message: string } | null;
  // The worker's own final report — real text a completed/ready_for_approval
  // job's worker actually wrote (job-store.cjs's job.result, unmodified;
  // see engineering-job-runner.cjs / autonomous-engineering-job.cjs). null
  // until a worker attempt has actually produced one.
  result: { text?: string; changedFiles?: string[]; commitHash?: string | null } | null;
  events: JarvisJobEvent[];
};

type JarvisEngineeringJobResult = {
  ok: boolean;
  error?: string;
  data?: JarvisEngineeringJob | null;
};

type JarvisGoal = {
  id: string;
  title: string;
  status: "active" | "paused" | "done";
  nextAction: string | null;
  linkedJobIds: string[];
  createdAt: string;
  updatedAt: string;
};

type JarvisActiveGoalResult = {
  ok: boolean;
  error?: string;
  data?: JarvisGoal | null;
};

// Connections Status v1 (P2.4) — verbatim field shapes from Jarvis's own
// adapter/iris-bridge.cjs getConnectionsStatus(), never re-derived. A
// read-only "which integrations are available right now" readout — no
// write/reconnect control exists here.
type JarvisConnectionId = "personalOS" | "drive" | "calendar" | "github" | "webResearch" | "mail" | "claudeWorker";
type JarvisConnectionStatusValue = "connected" | "not_connected" | "unavailable";

type JarvisConnectionEntry = {
  id: JarvisConnectionId;
  label: string;
  status: JarvisConnectionStatusValue;
  detail: string;
};

type JarvisConnectionsStatusResult = {
  ok: boolean;
  error?: string;
  data?: { connections: JarvisConnectionEntry[]; checkedAt: string };
};

interface Window {
  iris: IrisApi;
}
