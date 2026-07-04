/// <reference types="vite/client" />

type SidecarMode = "none" | "camera" | "screen";

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
    | "open_brain_note"
    | "close_brain_note"
    | "show_full_brain_graph";
  target_id?: string;
  query?: string;
};

type IrisConfig = {
  geminiApiKey: string;
  geminiModel: string;
  geminiVoice: string;
  hermesUrl: string;
  hermesKey: string;
  hermesBin: string;
  hermesHome: string;
  hermesSession: string;
  brainPath: string;
  brainSemantic: boolean;
  brainAutoIndex: boolean;
  userName: string;
  loadTestData: boolean;
  wakeWord: boolean;
  sounds: boolean;
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
  embedded?: number;
  reused?: number;
  pruned?: number;
  ms?: number;
  model?: string;
  location?: string;
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
  loadBrain: () => Promise<BrainGraphResult>;
  readBrainNote: (relPath: string) => Promise<BrainNoteResult>;
  searchBrain: (query: string, topK?: number) => Promise<BrainSearchResult>;
  syncBrainIndex: (payload?: { vault?: string; key?: string }) => Promise<BrainIndexSyncResult>;
  onBrainChanged: (callback: () => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  toggleHud: () => Promise<{ mode: "deck" | "hud" }>;
  setHudInteractive: (on: boolean) => void;
  windowControl: (action: "close" | "minimize") => void;
  onHudMode: (callback: (payload: { mode: "deck" | "hud" }) => void) => () => void;
  onWakeRequest: (callback: () => void) => () => void;
  onSleepRequest: (callback: () => void) => () => void;
  sendCommand: (command: Record<string, unknown>) => Promise<void>;
  sendUiContext: (context: Record<string, unknown>) => void;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  notifyBootDone: () => void;
  onUiAction: (callback: (action: IrisUiAction) => void) => () => void;
  onAudioChunk: (callback: (chunk: LiveAudioChunk) => void) => () => void;
  onAudioInterrupt: (callback: () => void) => () => void;
  onSidecarEvent: (callback: (event: SidecarEvent) => void) => () => void;
};

interface Window {
  iris: IrisApi;
}
