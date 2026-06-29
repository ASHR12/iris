# Iris

A desktop voice companion that uses **Gemini Live** for natural realtime conversation and **Hermes Agent** for long-running work.

The app is designed as a voice-first front-end: you speak naturally, Gemini Live responds in realtime, and when the request needs tools or autonomous work, Gemini hands it to Hermes in the background.

## What This App Does

- Captures your microphone through Electron/Chromium with WebRTC audio cleanup.
- Streams cleaned audio to Gemini Live as 16 kHz PCM.
- Plays Gemini Live audio responses through the app using browser `AudioContext`.
- Lets Gemini use built-in Google Search for quick current facts.
- Lets Gemini hand serious work to Hermes through the Hermes local API server.
- Shows conversation in the Comms panel and Hermes jobs in the Hermes Tasks panel.
- Proactively announces Hermes results when a background task finishes.
- Supports interruption/barge-in: when you speak over Gemini, playback is flushed.
- Uses a dark-only "Orbital Deck" UI with an animated voice orb, keyboard shortcuts, Comms, Camera/Gesture, and Work Stream columns.
- Adds **camera hand-gesture control** (MediaPipe) after wake so you can drive the UI in the air: point to move a cursor, dwell to open a task, open-palm to scroll, and make a fist to dismiss.
- Uses a simple polished reader open/close animation for expanded Hermes results.

## Current Architecture

```mermaid
flowchart TD
  User["User speaks"] --> ElectronRenderer["Electron Renderer UI"]

  ElectronRenderer -->|"getUserMedia with echoCancellation, noiseSuppression, autoGainControl"| WebRTCAudio["WebRTC Audio Capture"]
  WebRTCAudio -->|"Downsample to 16k PCM chunks"| ElectronMain["Electron Main Process"]

  ElectronMain -->|"sendRealtimeInput audio/text"| GeminiLive["Gemini Live API"]

  GeminiLive -->|"Voice response: 24k PCM audio chunks"| ElectronMain
  ElectronMain -->|"live:audio IPC"| ElectronRenderer
  ElectronRenderer -->|"AudioContext playback"| Speaker["Laptop Speaker"]

  GeminiLive -->|"Transcripts and state events"| ElectronMain
  ElectronMain -->|"sidecar:event IPC"| ElectronRenderer
  ElectronRenderer --> Comms["Comms Panel"]

  GeminiLive -->|"Quick current fact or lightweight search"| GoogleSearch["Gemini Built-in Google Search"]
  GoogleSearch --> GeminiLive

  GeminiLive -->|"Function call: submit_hermes_task"| HermesTool["Hermes Tool Bridge in Electron Main"]

  HermesTool -->|"POST /v1/runs"| HermesAPI["Hermes Local API Server"]
  HermesAPI --> HermesAgent["Hermes Agent Worker"]

  HermesAgent -->|"Uses terminal, files, browser, web, MCP, memory"| HermesTools["Hermes Tool Ecosystem"]

  HermesTool -->|"Poll GET /v1/runs/run_id"| HermesAPI
  HermesAPI -->|"Run status/result"| HermesTool

  HermesTool -->|"Task status updates"| ElectronRenderer
  ElectronRenderer --> HermesTasks["Hermes Tasks Panel"]

  HermesTool -->|"SYSTEM_EVENT_HERMES_COMPLETE"| GeminiLive
  GeminiLive -->|"Proactive spoken summary"| ElectronMain
  ElectronMain -->|"Audio chunks"| ElectronRenderer
  ElectronRenderer --> Speaker

  User -->|"Interrupts while Gemini speaks"| WebRTCAudio
  WebRTCAudio -->|"Cleaned mic audio with browser AEC"| GeminiLive
  GeminiLive -->|"serverContent.interrupted"| ElectronMain
  ElectronMain -->|"Flush playback"| ElectronRenderer

  User -->|"After wake: hand in front of webcam"| Camera["Webcam getUserMedia"]
  Camera --> MediaPipe["MediaPipe GestureRecognizer (on-device)"]
  MediaPipe -->|"Landmarks + gesture class"| HandHook["useHandControl hook"]
  HandHook -->|"Smoothed pointer + gesture state"| ElectronRenderer
```

## How The Flow Works

1. **You speak to the app.**

   Electron captures your microphone using Chromium's WebRTC audio path:

   ```ts
   echoCancellation: true
   noiseSuppression: true
   autoGainControl: true
   ```

   This gives the app laptop-speaker echo cancellation similar to browser/mobile voice apps.

2. **The renderer streams audio to Electron main.**

   The renderer downsamples microphone audio to 16 kHz PCM chunks and sends them over Electron IPC.

3. **Electron main streams to Gemini Live.**

   Electron main owns the Gemini Live session using `@google/genai` and sends audio via `sendRealtimeInput`.

4. **Gemini decides the route.**

   Gemini has two tool paths:

   - **Google Search** for quick current facts and simple web lookups.
   - **Hermes tools** for real work: deals, research, coding, files, terminal work, email checks, browser tasks, automation, and anything that should continue in the background.

5. **Hermes runs work in the background.**

   When Gemini calls `submit_hermes_task`, Electron main submits the task to Hermes using:

   ```text
   POST /v1/runs
   ```

   Hermes returns a `run_id` immediately, so Gemini can keep talking instead of waiting.

6. **The app tracks Hermes.**

   Electron polls Hermes run status and updates the Hermes Tasks panel.

7. **Hermes completion is fed back to Gemini.**

   When a run completes, Electron sends Gemini an internal message:

   ```text
   SYSTEM_EVENT_HERMES_COMPLETE
   ```

   Gemini then proactively tells you Hermes has returned, summarizes the result, and asks whether you want to go through the details before continuing.

8. **You can interrupt Gemini.**

   If you speak while Gemini is talking, Gemini sends an interruption event. The app flushes queued playback so Gemini stops talking over you.

## Main Components

### Electron Main

File: `electron/main.mjs`

Responsibilities:

- Loads `.env`.
- Creates the Gemini Live session.
- Defines Gemini tools.
- Bridges Gemini tool calls to Hermes.
- Sends/receives Gemini audio.
- Polls Hermes runs.
- Announces Hermes completion back into Gemini.

### Electron Preload

File: `electron/preload.cjs`

Responsibilities:

- Exposes safe IPC APIs to the renderer.
- Sends microphone PCM chunks to Electron main.
- Receives Gemini audio chunks and interruption events.
- Receives app state events.

### React Renderer

Files:

- `src/App.tsx`
- `src/App.css`
- `src/deck.css`
- `src/ReactorCore.tsx`
- `src/BootSequence.tsx`
- `src/useHandControl.ts` (MediaPipe hand/gesture hook)

Responsibilities:

- Renders the UI.
- Captures microphone with WebRTC audio cleanup.
- Downsamples mic audio to 16 kHz PCM.
- Plays Gemini audio through `AudioContext`.
- Shows Comms and Hermes Tasks.
- Renders the dark-only Orbital Deck layout.
- Provides keyboard shortcuts.
- Runs camera hand-gesture control after wake and simple reader open/close animation.

### Python Sidecar

Files under `sidecar/`

This was the original Gemini Live/PyAudio prototype. The current app now uses Electron-native audio for better laptop-speaker echo cancellation, but the Python sidecar remains useful as a reference and for future experiments.

## Hand & Gesture Control (MediaPipe)

The app can be driven in the air with your webcam. The camera does **not** start
on app boot; it is enabled automatically after wake, once Gemini Live and mic
capture are initialized. Hand tracking and gesture
classification run **fully on-device** using Google's
[MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer)
`GestureRecognizer`. No camera frames ever leave your machine — only the derived
pointer position and gesture label are used by the UI.

File: `src/useHandControl.ts` (consumed by `src/App.tsx`).

### What we use

- **Package:** `@mediapipe/tasks-vision` (the WebAssembly "Tasks Vision" runtime).
- **Task:** `GestureRecognizer` — a pre-trained model that returns both hand
  landmarks and a classified gesture in one pass.
- **Model asset:** `gesture_recognizer.task` (Google's canned-gesture classifier).
- **WASM runtime:** loaded via `FilesetResolver.forVisionTasks(...)` from the
  MediaPipe CDN.

### How we configure it

```ts
const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
recognizer = await GestureRecognizer.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
  runningMode: "VIDEO",
  numHands: 1,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.6,
  minTrackingConfidence: 0.6,
  cannedGesturesClassifierOptions: { scoreThreshold: 0.55 },
});
```

- **GPU delegate** for low-latency inference, **VIDEO** running mode for a live
  webcam stream.
- **One hand** is tracked to keep the interaction unambiguous.
- Confidence floors (`0.6`) and a canned-gesture score threshold (`0.55`) reject
  weak/uncertain frames.

### The processing pipeline

1. After wake, `navigator.mediaDevices.getUserMedia` opens the front camera at
   640×480 into a hidden `<video>` element.
2. A `requestAnimationFrame` loop calls
   `recognizer.recognizeForVideo(video, performance.now())` each frame.
3. From the result we read the first hand's **landmarks** and the **top gesture**.
4. **Pointer:** we take the index-fingertip landmark (`hand[8]`), mirror X
   (`1 - x`) for a natural selfie view, then remap a comfortable center region of
   the frame to the full screen (so you don't have to reach the physical edges):

   ```ts
   const INPUT_RANGE = { xMin: 0.18, xMax: 0.82, yMin: 0.12, yMax: 0.82 };
   ```

   The mapped point is then **exponentially smoothed** (factor `0.5`) to remove jitter.
5. **Gesture stabilization:** a raw gesture must persist for **3 frames** before it
   becomes the "stable" gesture, which prevents flicker between classes.

### Gesture → action mapping

| Gesture (MediaPipe class) | Action in the app |
| --- | --- |
| `Pointing_Up` | Move the on-screen cursor; **dwell ~850 ms** over a task card to open it |
| `Open_Palm` | **Hold-to-scroll** the open reader (joystick: hold high = scroll up, low = scroll down, middle = neutral; speed scales with distance) |
| `Closed_Fist` | Close the expanded reader |
| `None` / other | Idle — pointer hidden |

### Gesture control flow

```mermaid
flowchart TD
  Webcam["Webcam 640x480"] --> Video["Hidden video element"]
  Video --> Loop["requestAnimationFrame loop"]
  Loop --> Recognize["GestureRecognizer.recognizeForVideo"]
  Recognize --> Landmarks["Hand landmarks - index fingertip"]
  Recognize --> GestureClass["Top gesture + score"]

  Landmarks --> Mirror["Mirror X + remap center region to screen"]
  Mirror --> Smooth["Exponential smoothing (0.5)"]
  Smooth --> Pointer["Smoothed screen pointer"]

  GestureClass --> Stabilize["Stabilize: hold 3 frames"]
  Stabilize --> StableGesture["Stable gesture"]

  Pointer --> HandState["HandState"]
  StableGesture --> HandState
  HandState --> AppUI["App.tsx interactions"]

  AppUI -->|"Pointing_Up + brief dwell"| OpenCard["Open task card"]
  AppUI -->|"Open_Palm"| Scroll["Hold-to-scroll reader"]
  AppUI -->|"Closed_Fist"| Close["Close reader"]
```

### Reader animation

Expanded Hermes task results open with a simple scale/fade pop and close with a
short fade/scale animation. The intentionally simple animation keeps the UI
clean and avoids expensive DOM rasterization.

## Gemini Tools

Gemini Live is configured with:

```js
tools: [
  { googleSearch: {} },
  {
    functionDeclarations: [
      check_hermes_status,
      submit_hermes_task,
      get_hermes_task_status,
      stop_hermes_task,
      approve_hermes_action,
    ]
  }
]
```

Routing behavior:

- Quick answer or current fact: **Gemini Search**.
- Multi-step work or background task: **Hermes**.
- Hermes completion: **Gemini proactively announces result**.

## Hermes Requirements

The app expects the Hermes API server to be reachable at:

```text
http://127.0.0.1:8642
```

Your Hermes config should enable the local API server. Add this to
`~/.hermes/.env` (macOS/Linux) or the equivalent Hermes env file on Windows:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=iris-local-dev
```

Restart Hermes gateway after changing this:

```bash
hermes gateway restart
```

Verify:

```bash
curl -s http://127.0.0.1:8642/health
```

Expected output:

```json
{"status":"ok"}
```

## App Environment

Iris reads environment values from:

1. `.env` in this repo (development and `npm start`).
2. `~/.iris/.env` (packaged app on macOS/Linux).
3. `%USERPROFILE%\\.iris\\.env` (packaged app on Windows).
4. `.env` bundled next to app resources (optional packaging flow).

Copy the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Minimum required:

```bash
GEMINI_API_KEY=your_google_ai_studio_key
```

Recommended example:

```bash
GEMINI_API_KEY=your_google_ai_studio_key
IRIS_USER_NAME=there
IRIS_LOAD_TEST_DATA=false
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_LIVE_VOICE=Zephyr
HERMES_API_URL=http://127.0.0.1:8642
API_SERVER_KEY=iris-local-dev
```

`HERMES_BIN` is optional. Set it only if the packaged GUI app cannot find the
Hermes binary on PATH. If the Hermes gateway is already running, Iris only needs
`HERMES_API_URL` and `API_SERVER_KEY`.

Set `IRIS_LOAD_TEST_DATA=true` to auto-load demo Comms messages and Hermes task
cards at startup for UI testing. Leave it `false` for normal use.

## Exact Google Models, SDKs & Assets (pinned reference)

Use this table as the single source of truth for **which Google pieces we use**,
so future changes don't reintroduce wrong/deprecated names or version drift.

| Purpose | Exact identifier we use | Where it's set | Source |
| --- | --- | --- | --- |
| Gemini Live model | `models/gemini-3.1-flash-live-preview` | `electron/main.mjs` (`GEMINI_LIVE_MODEL` env override) | Google AI Studio / Gemini API |
| Gemini voice | `Zephyr` | `electron/main.mjs` (`GEMINI_LIVE_VOICE` env override) | Gemini Live prebuilt voices |
| Gemini SDK | `@google/genai` `^2.10.0` | `package.json` | npm |
| Gemini built-in search tool | `{ googleSearch: {} }` | `electron/main.mjs` `tools` | Gemini Live tools |
| Gesture/hand ML runtime | `@mediapipe/tasks-vision` `^0.10.35` | `package.json` | npm |
| MediaPipe WASM fileset | `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm` | `src/useHandControl.ts` (`WASM_URL`) | jsDelivr CDN |
| MediaPipe model asset | `https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task` | `src/useHandControl.ts` (`MODEL_URL`) | Google Cloud Storage |

### Known footguns / lessons (avoid repeating these)

- **Use the exact Live model name `gemini-3.1-flash-live-preview`.** Live models
  are a distinct family from regular `gemini-*` chat models; a normal chat model
  name will fail to open a Live session. Keep the `models/` prefix.
- **Keep the MediaPipe WASM URL version equal to the installed npm version.**
  Both are pinned to `0.10.35` today. A mismatch between the JS API
  (`@mediapipe/tasks-vision`) and the WASM fileset can cause subtle runtime/ABI
  breakage, so update the `@x.y.z` in `WASM_URL` whenever you bump the package
  (or self-host the WASM from the installed package instead of a CDN).
- **MediaPipe WASM + model are fetched from Google/jsDelivr at first load**, so
  gesture control needs network access on first run. Vendor both locally if you
  need fully offline startup.
- **Gemini Live audio formats are fixed:** send **16 kHz** PCM, receive **24 kHz**
  PCM. Don't assume a single sample rate for both directions.
- **Gemini 3.1 Live function calls are synchronous** — never block a tool call on
  long Hermes work; return a `run_id` immediately and track completion separately.
- **Send realtime input with `sendRealtimeInput`** (not the deprecated
  `media_chunks` path) for audio/text streaming.

## Setup From Source

### Prerequisites

- Node.js 20+ (LTS recommended).
- npm.
- Hermes Agent installed and able to run `hermes gateway`.
- A Gemini API key for the Live model (`GEMINI_API_KEY`).
- macOS, Windows, or Linux with microphone permission available.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Gemini and Iris

Create `.env` from `.env.example` and set at least `GEMINI_API_KEY`.

### 3. Enable Hermes gateway API

Make sure Hermes API is enabled:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
echo 'API_SERVER_KEY=iris-local-dev' >> ~/.hermes/.env
hermes gateway restart
```

On Windows, edit your Hermes env file manually and add the same two values:

```env
API_SERVER_ENABLED=true
API_SERVER_KEY=iris-local-dev
```

Then restart Hermes gateway.

Verify:

```bash
curl http://127.0.0.1:8642/health
```

Expected:

```json
{"status":"ok"}
```

### 4. Run in development mode

```bash
npm run dev
```

This starts Vite and Electron with hot reload. In dev mode the macOS Dock may
show the generic Electron app name, but the packaged app is named Iris.

### 5. Run a production build without packaging

```bash
npm start
```

This builds `dist/` and launches Electron from the built files.

If you already built once:

```bash
npm run start:prod
```

### 6. Build/check only

```bash
npm run build
```

## Packaging

### macOS

```bash
npm run package:mac
open release/mac-arm64/Iris.app
```

The app is unsigned by default. If macOS blocks it, right-click the app and choose
**Open** once.

### Windows

From Windows:

```powershell
npm install
Copy-Item .env.example .env
# edit .env and set GEMINI_API_KEY, HERMES_API_URL, API_SERVER_KEY
npm run dev
```

To create an unpacked Windows app directory:

```powershell
npm run package:win
```

To create a distributable Windows build:

```powershell
npm run dist:win
```

For the packaged Windows app, copy `.env.example` to:

```text
%USERPROFILE%\\.iris\\.env
```

Then set `GEMINI_API_KEY` and Hermes values there.

## Controls

- **W**: Wake
- **S**: Sleep
- Top-right signal icon: live connection indicator
- Top-right hand icon: manually enables/disables camera gesture tracking

Camera/gesture behavior:

- App boot: camera is off.
- Wake (`W`): Gemini Live starts, mic capture starts, then camera/gesture control starts automatically.
- Sleep (`S`): Gemini, mic, and camera/gesture control stop.

### Hand gestures (when camera control is enabled)

- **Point (index up)**: move the cursor; hold over a task card briefly to open it
- **Open palm**: hold-to-scroll inside Comms, Work Stream, and the open reader (high = up, low = down)
- **Closed fist**: close the reader

> The first launch will prompt for camera permission. Frames are processed
> on-device by MediaPipe and never uploaded.

## Notes

- The app now uses Electron/Chromium microphone capture instead of Python `pyaudio` for the main Gemini Live path. This gives better echo cancellation on laptop speakers.
- Gemini Live model: `gemini-3.1-flash-live-preview`.
- Gemini 3.1 Live function calls are synchronous, so Hermes tasks return a `run_id` immediately and finish in the background.
- Hermes remains your actual worker agent for tool-heavy tasks.
- Hand tracking uses `@mediapipe/tasks-vision` (`GestureRecognizer`) entirely on-device and starts only after wake unless manually enabled.

## Open-Source Notes

- `.env` is ignored. Do not commit real Gemini keys or Hermes API keys.
- The default `API_SERVER_KEY=iris-local-dev` is for local development only; choose
  your own local key if you share the app broadly.
- The packaged app is unsigned unless you add your own Apple/Windows signing
  certificates.
- Licensed under the MIT License. See `LICENSE`.
