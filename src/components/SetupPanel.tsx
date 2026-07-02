import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  Play,
  Wand2,
  X,
} from "lucide-react";

type Mode = "onboarding" | "settings";
type TestState = { status: "idle" | "testing" | "ok" | "error"; message?: string };
type PermState = "idle" | "granted" | "denied";

type Draft = {
  GEMINI_API_KEY: string;
  GEMINI_LIVE_MODEL: string;
  GEMINI_LIVE_VOICE: string;
  HERMES_API_URL: string;
  API_SERVER_KEY: string;
  HERMES_BIN: string;
  HERMES_HOME: string;
  IRIS_USER_NAME: string;
  IRIS_LOAD_TEST_DATA: string;
  IRIS_WAKE_WORD: string;
  IRIS_SOUNDS: string;
};

const WIZARD_STEPS = ["welcome", "gemini", "hermes", "you", "permissions", "finish"] as const;

export default function SetupPanel({
  mode,
  config,
  onClose,
  onSaved,
  onStart,
  onRunWizard,
}: {
  mode: Mode;
  config: IrisConfig;
  onClose: () => void;
  onSaved: (config: IrisConfig) => void;
  onStart?: () => void;
  onRunWizard?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    GEMINI_API_KEY: config.geminiApiKey,
    GEMINI_LIVE_MODEL: config.geminiModel,
    GEMINI_LIVE_VOICE: config.geminiVoice,
    HERMES_API_URL: config.hermesUrl,
    API_SERVER_KEY: config.hermesKey,
    HERMES_BIN: config.hermesBin,
    HERMES_HOME: config.hermesHome,
    IRIS_USER_NAME: config.userName,
    IRIS_LOAD_TEST_DATA: config.loadTestData ? "true" : "false",
    IRIS_WAKE_WORD: config.wakeWord ? "true" : "false",
    IRIS_SOUNDS: config.sounds ? "true" : "false",
  });
  const [step, setStep] = useState(0);
  const [gemini, setGemini] = useState<TestState>({ status: "idle" });
  const [hermes, setHermes] = useState<TestState>({ status: "idle" });
  const [preview, setPreview] = useState<TestState>({ status: "idle" });
  const [mic, setMic] = useState<PermState>("idle");
  const [cam, setCam] = useState<PermState>("idle");
  const [saving, setSaving] = useState(false);

  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  // Reflect the OS/browser's actual permission state so previously-granted mic or
  // camera shows as "Granted" instead of asking again every time Settings opens.
  useEffect(() => {
    if (!navigator.permissions?.query) return;
    let cancelled = false;
    const toState = (state: PermissionState): PermState =>
      state === "granted" ? "granted" : state === "denied" ? "denied" : "idle";

    const watch = async (name: "microphone" | "camera", setter: (value: PermState) => void) => {
      try {
        const status = await navigator.permissions.query({ name: name as PermissionName });
        if (cancelled) return;
        setter(toState(status.state));
        status.onchange = () => setter(toState(status.state));
      } catch {
        // Some platforms don't support querying these names; leave as idle.
      }
    };

    watch("microphone", setMic);
    watch("camera", setCam);
    return () => {
      cancelled = true;
    };
  }, []);

  async function testGemini() {
    setGemini({ status: "testing" });
    const result = await window.iris.testGemini(draft.GEMINI_API_KEY.trim());
    setGemini(result.ok ? { status: "ok", message: "Key works." } : { status: "error", message: result.error });
  }

  async function testHermes() {
    setHermes({ status: "testing" });
    const result = await window.iris.testHermes({
      url: draft.HERMES_API_URL.trim(),
      key: draft.API_SERVER_KEY.trim(),
    });
    const version =
      result.health && typeof result.health.version === "string" ? ` · v${result.health.version}` : "";
    setHermes(
      result.ok ? { status: "ok", message: `Reachable${version}.` } : { status: "error", message: result.error },
    );
  }

  async function doPreview() {
    setPreview({ status: "testing" });
    const result = await window.iris.previewVoice({
      voice: draft.GEMINI_LIVE_VOICE,
      key: draft.GEMINI_API_KEY.trim(),
    });
    setPreview(result.ok ? { status: "idle" } : { status: "error", message: result.error });
  }

  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMic("granted");
    } catch {
      setMic("denied");
    }
  }

  async function requestCam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      setCam("granted");
    } catch {
      setCam("denied");
    }
  }

  async function save() {
    setSaving(true);
    const updated = await window.iris.saveConfig({ ...draft });
    setSaving(false);
    onSaved(updated);
    return updated;
  }

  async function finishWizard() {
    await save();
    onClose();
    onStart?.();
  }

  const keyReady = draft.GEMINI_API_KEY.trim().length > 0;

  // ---- Section renderers (shared between wizard steps and settings) ----
  const geminiSection = (
    <Section title="Gemini API key" hint="Powers Iris's realtime voice. Get one free at Google AI Studio.">
      <label className="setup-field">
        <span>API key</span>
        <input
          type="password"
          value={draft.GEMINI_API_KEY}
          placeholder="AI… paste your key"
          onChange={(event) => {
            set("GEMINI_API_KEY", event.target.value);
            setGemini({ status: "idle" });
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <small className="setup-note">
          Get a free key from{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Google AI Studio
          </a>
          , then paste the whole thing. Stored locally only.
        </small>
      </label>
      <div className="setup-actions">
        <button className="setup-btn" onClick={testGemini} disabled={!keyReady || gemini.status === "testing"}>
          {gemini.status === "testing" ? <Loader2 size={14} className="spin" /> : null}
          Test Gemini
        </button>
        <TestBadge state={gemini} okLabel="Key works" />
      </div>
    </Section>
  );

  const hermesSection = (
    <Section title="Hermes" hint="Iris hands long-running work to your local Hermes agent.">
      <label className="setup-field">
        <span>API URL</span>
        <input
          value={draft.HERMES_API_URL}
          placeholder="http://127.0.0.1:8642"
          onChange={(event) => {
            set("HERMES_API_URL", event.target.value);
            setHermes({ status: "idle" });
          }}
          spellCheck={false}
        />
        <small className="setup-note">
          Address of your local Hermes API server. Keep <code>http://127.0.0.1:8642</code> unless you changed Hermes's
          port. Start it with <code>hermes gateway start</code>.
        </small>
      </label>
      <label className="setup-field">
        <span>API key</span>
        <input
          value={draft.API_SERVER_KEY}
          placeholder="iris-local-dev"
          onChange={(event) => {
            set("API_SERVER_KEY", event.target.value);
            setHermes({ status: "idle" });
          }}
          spellCheck={false}
        />
        <small className="setup-note">
          Must match <code>API_SERVER_KEY</code> in Hermes's own <code>~/.hermes/.env</code>. Default for local dev is{" "}
          <code>iris-local-dev</code>.
        </small>
      </label>
      <div className="setup-actions">
        <button className="setup-btn" onClick={testHermes} disabled={hermes.status === "testing"}>
          {hermes.status === "testing" ? <Loader2 size={14} className="spin" /> : null}
          Test Hermes
        </button>
        <TestBadge state={hermes} okLabel="Reachable" />
      </div>
      <label className="setup-field">
        <span>Hermes home (optional)</span>
        <input
          value={draft.HERMES_HOME}
          placeholder="~/.hermes"
          onChange={(event) => set("HERMES_HOME", event.target.value)}
          spellCheck={false}
        />
        <small className="setup-note">
          Folder where Hermes keeps its data and memory (<code>memories/USER.md</code>, <code>MEMORY.md</code>) — Iris
          reads these so it knows your context. Leave blank to use <code>~/.hermes</code>.
        </small>
      </label>
      <label className="setup-field">
        <span>Hermes binary (optional)</span>
        <input
          value={draft.HERMES_BIN}
          placeholder="auto-detected on PATH"
          onChange={(event) => set("HERMES_BIN", event.target.value)}
          spellCheck={false}
        />
        <small className="setup-note">
          Full path to the <code>hermes</code> program (e.g. <code>/Users/you/.local/bin/hermes</code>). Leave blank —
          only set this if Iris can't find Hermes automatically.
        </small>
      </label>
    </Section>
  );

  const advancedSection = (
    <Section title="Advanced" hint="Demo data is selectable; voice defaults are read-only.">
      <label className="setup-field">
        <span>Load demo / test data</span>
        <ThemedSelect
          ariaLabel="Load demo data"
          value={draft.IRIS_LOAD_TEST_DATA}
          options={[
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ]}
          onChange={(value) => set("IRIS_LOAD_TEST_DATA", value)}
        />
        <small className="setup-note">
          Fills the UI with fake tasks and conversation so you can explore Iris (and take screenshots) without running
          real Hermes work. Turn off for normal use.
        </small>
      </label>
      <div className="setup-readonly">
        <span>Voice duplex mode</span>
        <code>{config.voiceDuplexMode}</code>
      </div>
      <div className="setup-readonly">
        <span>Speaker echo guard</span>
        <code>{config.speakerEchoGuard}s</code>
      </div>
      <small className="setup-note">
        These two are tuned defaults for echo handling. They're read-only here — change them in <code>.env</code> only if
        you know what you're doing.
      </small>
    </Section>
  );

  const youSection = (
    <Section title="You & voice" hint="How Iris addresses you and which voice it speaks with.">
      <label className="setup-field">
        <span>Display name</span>
        <input
          value={draft.IRIS_USER_NAME}
          placeholder="Your name"
          onChange={(event) => set("IRIS_USER_NAME", event.target.value)}
          spellCheck={false}
        />
        <small className="setup-note">What Iris calls you out loud, e.g. “Ashutosh”.</small>
      </label>
      <label className="setup-field">
        <span>Voice</span>
        <div className="setup-inline">
          <ThemedSelect
            ariaLabel="Voice"
            value={draft.GEMINI_LIVE_VOICE}
            options={config.voices.map((voice) => ({ value: voice, label: voice }))}
            onChange={(value) => {
              set("GEMINI_LIVE_VOICE", value);
              setPreview({ status: "idle" });
            }}
          />
          <button
            className="setup-btn ghost"
            onClick={doPreview}
            disabled={!keyReady || preview.status === "testing"}
            title={keyReady ? "Preview this voice" : "Add your Gemini key first"}
          >
            {preview.status === "testing" ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            Preview
          </button>
        </div>
        <small className="setup-note">Iris's speaking voice. Tap Preview to hear a sample (needs a saved Gemini key).</small>
      </label>
      {preview.status === "error" ? <p className="setup-error">{preview.message}</p> : null}
      <label className="setup-field">
        <span>Model</span>
        <ThemedSelect
          ariaLabel="Model"
          value={draft.GEMINI_LIVE_MODEL}
          options={config.models.map((model) => ({ value: model, label: model.replace(/^models\//, "") }))}
          onChange={(value) => set("GEMINI_LIVE_MODEL", value)}
        />
        <small className="setup-note">Gemini Live model that powers realtime voice. Keep the default unless you have a reason to change it.</small>
      </label>
      <label className="setup-field">
        <span>Wake word — “Hey Iris”</span>
        <ThemedSelect
          ariaLabel="Wake word"
          value={draft.IRIS_WAKE_WORD}
          options={[
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ]}
          onChange={(value) => set("IRIS_WAKE_WORD", value)}
        />
        <small className="setup-note">
          When on, Iris listens locally for “Hey Iris” and wakes hands-free (same as pressing W). Runs fully on-device —
          no audio leaves your machine. Needs microphone permission.
        </small>
      </label>
      <label className="setup-field">
        <span>Interface sounds</span>
        <ThemedSelect
          ariaLabel="Interface sounds"
          value={draft.IRIS_SOUNDS}
          options={[
            { value: "true", label: "On" },
            { value: "false", label: "Off" },
          ]}
          onChange={(value) => set("IRIS_SOUNDS", value)}
        />
        <small className="setup-note">
          Subtle audio cues for wake, sleep, task sent, task done, and approval requests. Synthesized locally — quiet by
          design.
        </small>
      </label>
    </Section>
  );

  const permissionsSection = (
    <Section title="Permissions" hint="Iris needs your mic to hear you. Camera is optional (hand gestures).">
      <div className="setup-perms">
        <PermRow
          icon={<Mic size={16} />}
          label="Microphone"
          required
          state={mic}
          onRequest={requestMic}
        />
        <PermRow
          icon={<Camera size={16} />}
          label="Camera (gestures)"
          state={cam}
          onRequest={requestCam}
        />
      </div>
    </Section>
  );

  // ---- Settings mode: everything in one scroll ----
  if (mode === "settings") {
    return (
      <div className="setup-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className="setup-card settings">
          <header className="setup-head">
            <span>Settings</span>
            <button className="reader-close" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </header>
          <div className="setup-scroll">
            {geminiSection}
            {hermesSection}
            {youSection}
            {permissionsSection}
            {advancedSection}
            <p className="setup-path">Saved to {config.configPath}</p>
          </div>
          <footer className="setup-foot">
            <button className="setup-btn ghost" onClick={() => onRunWizard?.()}>
              <Wand2 size={14} />
              Run setup wizard
            </button>
            <div className="setup-foot-right">
              <button className="setup-btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="setup-btn primary"
                onClick={async () => {
                  await save();
                  onClose();
                }}
                disabled={saving}
              >
                {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                Save
              </button>
            </div>
          </footer>
        </div>
      </div>
    );
  }

  // ---- Onboarding mode: step-by-step wizard ----
  const current = WIZARD_STEPS[step];
  let body: ReactNode = null;
  if (current === "welcome") {
    body = (
      <div className="setup-welcome">
        <h2>Welcome to Iris</h2>
        <p>
          Iris is a hands-free voice command layer. Gemini Live handles the conversation and delegates real
          work to your Hermes agent. Let's get you set up in under a minute.
        </p>
      </div>
    );
  } else if (current === "gemini") {
    body = geminiSection;
  } else if (current === "hermes") {
    body = hermesSection;
  } else if (current === "you") {
    body = youSection;
  } else if (current === "permissions") {
    body = permissionsSection;
  } else {
    body = (
      <div className="setup-welcome">
        <h2>You're all set</h2>
        <p>Iris will save your settings and wake up. Press W any time to wake, S to sleep.</p>
        <ul className="setup-summary">
          <li>
            Gemini key {gemini.status === "ok" ? <Check size={13} className="ok" /> : keyReady ? "added" : "missing"}
          </li>
          <li>Voice · {draft.GEMINI_LIVE_VOICE}</li>
          <li>Name · {draft.IRIS_USER_NAME || "(not set)"}</li>
          <li>Mic · {mic === "granted" ? "granted" : "ask on start"}</li>
        </ul>
      </div>
    );
  }

  const isFirst = step === 0;
  const isLast = step === WIZARD_STEPS.length - 1;
  const canNext = current === "gemini" ? keyReady : true;

  return (
    <div className="setup-backdrop">
      <div className="setup-card wizard">
        <header className="setup-head">
          <span>Setup · {step + 1}/{WIZARD_STEPS.length}</span>
          <div className="setup-progress">
            {WIZARD_STEPS.map((name, index) => (
              <i key={name} className={index <= step ? "on" : ""} />
            ))}
          </div>
          <button className="reader-close" onClick={onClose} title="Close (configure later)">
            <X size={16} />
          </button>
        </header>
        <div className="setup-scroll">{body}</div>
        <footer className="setup-foot">
          <button className="setup-btn ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={isFirst}>
            <ChevronLeft size={14} />
            Back
          </button>
          {isLast ? (
            <button className="setup-btn primary" onClick={finishWizard} disabled={saving || !keyReady}>
              {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              Save & Start Iris
            </button>
          ) : (
            <button
              className="setup-btn primary"
              onClick={() => setStep((s) => Math.min(WIZARD_STEPS.length - 1, s + 1))}
              disabled={!canNext}
            >
              {isFirst ? "Get started" : "Next"}
              <ChevronRight size={14} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

type Option = { value: string; label: string };

// Fully themed dropdown (native <select> popups can't be styled to match on macOS).
// The menu is position:fixed off the trigger rect so the panel's scroll/overflow
// never clips it.
function ThemedSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDoc = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (btnRef.current?.contains(target) || target.closest(".ts-menu")) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Close when the page/panel scrolls, but NOT when scrolling inside the menu.
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target && typeof target.closest === "function" && target.closest(".ts-menu")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuMax = 260;
    const dropUp = rect.bottom + menuMax > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
    setPos({
      left: rect.left,
      width: rect.width,
      ...(dropUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
    setOpen(true);
  }

  return (
    <div className="ts">
      <button
        ref={btnRef}
        type="button"
        className={`ts-trigger ${open ? "open" : ""}`}
        onClick={toggle}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span className="ts-value">{current?.label ?? value}</span>
        <ChevronDown size={14} className="ts-chev" />
      </button>
      {open && pos ? (
        <div
          className="ts-menu"
          style={{
            position: "fixed",
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ts-option ${option.value === value ? "sel" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="setup-section">
      <h3>{title}</h3>
      {hint ? <p className="setup-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function TestBadge({ state, okLabel }: { state: TestState; okLabel: string }) {
  if (state.status === "ok") {
    return (
      <span className="setup-result ok">
        <Check size={13} />
        {state.message || okLabel}
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <span className="setup-result err" title={state.message}>
        <X size={13} />
        {state.message || "Failed"}
      </span>
    );
  }
  return null;
}

function PermRow({
  icon,
  label,
  required,
  state,
  onRequest,
}: {
  icon: ReactNode;
  label: string;
  required?: boolean;
  state: PermState;
  onRequest: () => void;
}) {
  return (
    <div className={`setup-perm ${state}`}>
      <span className="perm-icon">{icon}</span>
      <span className="perm-label">
        {label}
        {required ? <em>required</em> : <em>optional</em>}
      </span>
      {state === "granted" ? (
        <span className="setup-result ok">
          <Check size={13} />
          Granted
        </span>
      ) : (
        <button className="setup-btn ghost" onClick={onRequest}>
          {state === "denied" ? "Retry" : "Allow"}
        </button>
      )}
    </div>
  );
}
