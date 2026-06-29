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
    | "close_all_overlays";
  target_id?: string;
  query?: string;
};

type IrisApi = {
  startSidecar: (options?: { mode?: SidecarMode }) => Promise<{ running: boolean; pid: number | null }>;
  stopSidecar: () => Promise<{ running: boolean; pid: number | null }>;
  getSidecarStatus: () => Promise<{ running: boolean; pid: number | null }>;
  getAppConfig: () => Promise<{ loadTestData: boolean; userName: string }>;
  sendCommand: (command: Record<string, unknown>) => Promise<void>;
  sendUiContext: (context: Record<string, unknown>) => void;
  sendAudioChunk: (chunk: ArrayBuffer) => void;
  onUiAction: (callback: (action: IrisUiAction) => void) => () => void;
  onAudioChunk: (callback: (chunk: LiveAudioChunk) => void) => () => void;
  onAudioInterrupt: (callback: () => void) => () => void;
  onSidecarEvent: (callback: (event: SidecarEvent) => void) => () => void;
};

interface Window {
  iris: IrisApi;
}
