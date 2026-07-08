import { useEffect, useRef } from "react";
import * as ort from "onnxruntime-web";

// Local "Hey Iris" wake word. Ports the livekit-wakeword / openWakeWord inference
// pipeline (mel-spectrogram -> speech embedding -> classifier) to the browser via
// onnxruntime-web. Fully on-device: audio never leaves the machine, and nothing is
// sent to Gemini/Hermes until a wake fires. Models live in public/wakeword/.

const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = SAMPLE_RATE * 2; // ~2s -> exactly 16 embeddings
const N_MEL = 32;
const EMB_WINDOW = 76; // mel frames per embedding
const EMB_STRIDE = 8; // mel frames between embeddings
const N_EMB = 16; // classifier input length
const PREDICT_INTERVAL_MS = 200;
// Balanced default: the model is trained on synthetic voices, so real speech
// tends to produce ONE brief score spike per utterance — a wake must fire on
// a single hot frame, instantly. The Settings "sensitivity" select passes a
// different threshold in (relaxed/strict).
const DEFAULT_THRESHOLD = 0.12;
// False-wake guard that can never block clear speech: an adaptive noise
// floor. A rolling average of recent scores estimates how "hot" the room is;
// the effective firing bar is raised only while that background level is
// elevated (TV, music, chatter) and decays back within seconds of quiet.
// In a quiet room the bar IS the configured threshold — nothing extra.
const NOISE_ALPHA = 0.05; // ~4s memory at 5 predictions/sec
const NOISE_MULTIPLIER = 3.5; // spike must stand this far above the background
const FLOOR_CAP_FACTOR = 2.2; // the bar can never exceed threshold * this
const COOLDOWN_MS = 2500;

let ortConfigured = false;
function configureOrt() {
  if (ortConfigured) return;
  // Match the installed package version. Consistent with the MediaPipe CDN approach.
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
  ort.env.wasm.numThreads = 1; // avoid SharedArrayBuffer / COOP-COEP requirements
  ortConfigured = true;
}

async function createSession(url: string): Promise<ort.InferenceSession> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
}

type WakeSessions = { mel: ort.InferenceSession; emb: ort.InferenceSession; cls: ort.InferenceSession };

// Load the three ONNX models once and reuse them across every arm/disarm cycle, so
// re-arming after Iris sleeps is instant (no "loading models" gap where a spoken
// "Hey Iris" would be missed).
let sessionsPromise: Promise<WakeSessions> | null = null;
function getSessions(): Promise<WakeSessions> {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      configureOrt();
      const base = import.meta.env.BASE_URL;
      const [mel, emb, cls] = await Promise.all([
        createSession(`${base}wakeword/melspectrogram.onnx`),
        createSession(`${base}wakeword/embedding_model.onnx`),
        createSession(`${base}wakeword/hey_iris.onnx`),
      ]);
      return { mel, emb, cls };
    })().catch((error) => {
      sessionsPromise = null; // allow a retry on next arm if loading failed
      throw error;
    });
  }
  return sessionsPromise;
}

export function useWakeWord(
  enabled: boolean,
  onWake: () => void,
  onError?: (message: string) => void,
  threshold: number = DEFAULT_THRESHOLD,
  micDeviceId = "",
) {
  const onWakeRef = useRef(onWake);
  const onErrorRef = useRef(onError);
  onWakeRef.current = onWake;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let timer: number | null = null;

    let mel: ort.InferenceSession | null = null;
    let emb: ort.InferenceSession | null = null;
    let cls: ort.InferenceSession | null = null;

    const ring = new Float32Array(WINDOW_SAMPLES);
    let filled = 0;
    let busy = false;
    let lastWakeAt = 0;
    let peakScore = 0;
    let lastPeakLogAt = 0;
    let noiseEma = 0;

    async function predict() {
      if (busy || cancelled || !mel || !emb || !cls || filled < WINDOW_SAMPLES) return;
      busy = true;
      try {
        // 1) Mel spectrogram over the 2s window -> [1, 1, T, 32], then x/10 + 2.
        const melInput = new ort.Tensor("float32", ring.slice(0), [1, WINDOW_SAMPLES]);
        const melResult = await mel.run({ [mel.inputNames[0]]: melInput });
        const melTensor = melResult[mel.outputNames[0]];
        const melData = melTensor.data as Float32Array;
        const frames = melTensor.dims[2] as number; // [1,1,T,32]

        const nWindows = Math.floor((frames - EMB_WINDOW) / EMB_STRIDE) + 1;
        if (nWindows < N_EMB) return;
        const startWindow = nWindows - N_EMB; // use the most recent 16 windows

        // 2) Build 16 mel windows -> embedding batch input [16, 76, 32, 1].
        const embInputData = new Float32Array(N_EMB * EMB_WINDOW * N_MEL);
        for (let w = 0; w < N_EMB; w++) {
          const winStartFrame = (startWindow + w) * EMB_STRIDE;
          for (let f = 0; f < EMB_WINDOW; f++) {
            const srcOffset = (winStartFrame + f) * N_MEL; // batch=ch=1 -> t*32 + m
            const dstOffset = (w * EMB_WINDOW + f) * N_MEL;
            for (let m = 0; m < N_MEL; m++) {
              embInputData[dstOffset + m] = melData[srcOffset + m] / 10 + 2;
            }
          }
        }
        const embInput = new ort.Tensor("float32", embInputData, [N_EMB, EMB_WINDOW, N_MEL, 1]);
        const embResult = await emb.run({ [emb.inputNames[0]]: embInput });
        const embData = embResult[emb.outputNames[0]].data as Float32Array; // [16,1,1,96] -> 16*96

        // 3) Classifier over the 16-embedding sequence -> score.
        const clsInput = new ort.Tensor("float32", embData.slice(0), [1, N_EMB, 96]);
        const clsResult = await cls.run({ [cls.inputNames[0]]: clsInput });
        const score = (clsResult[cls.outputNames[0]].data as Float32Array)[0];

        // Logging so you can see it working in the DevTools console:
        // - a live peak score once per second, and
        // - any "near miss" frame that gets reasonably close to the threshold.
        // Effective firing bar: the configured threshold, lifted only while
        // the recent background has been scoring hot (noisy room), capped so
        // it can never run away and permanently deafen the detector.
        const floor = Math.min(
          threshold * FLOOR_CAP_FACTOR,
          Math.max(threshold, noiseEma * NOISE_MULTIPLIER),
        );

        const now = performance.now();
        peakScore = Math.max(peakScore, score);
        if (now - lastPeakLogAt >= 1000) {
          const floorNote = floor > threshold + 0.001 ? ` (noisy room — bar raised to ${floor.toFixed(3)})` : "";
          console.log(`[wakeword] listening… peak score ${peakScore.toFixed(3)} (fires at ${threshold})${floorNote}`);
          peakScore = 0;
          lastPeakLogAt = now;
        }
        if (score >= 0.05 && score < floor) {
          console.log(`[wakeword] near miss: ${score.toFixed(3)} (bar ${floor.toFixed(3)})`);
        }

        // Fire INSTANTLY on a single frame over the bar — the synthetic-data
        // model spikes briefly for real voices, so no multi-frame demands.
        // The cooldown prevents rapid double-fires from the same utterance.
        if (score >= floor && now - lastWakeAt > COOLDOWN_MS) {
          lastWakeAt = now;
          console.log(`[wakeword] ✅ WAKE — "Hey Iris" detected (score ${score.toFixed(3)})`);
          onWakeRef.current();
        }

        // Update the background estimate AFTER the decision, clamped at the
        // threshold so genuine wake spikes never inflate the noise floor.
        noiseEma += NOISE_ALPHA * (Math.min(score, threshold) - noiseEma);
      } catch (error) {
        // Best-effort: a single failed frame shouldn't kill the listener.
        console.error("[wakeword] predict failed", error);
      } finally {
        busy = false;
      }
    }

    async function init() {
      try {
        console.log("[wakeword] preparing models (cached after first load)…");
        const sessions = await getSessions();
        mel = sessions.mel;
        emb = sessions.emb;
        cls = sessions.cls;
        if (cancelled) return;
        console.log("[wakeword] models ready, requesting microphone…");

        const audioBase = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (micDeviceId) {
          // Chosen mic wins when present ("exact"); unplugged falls through
          // to the system default so wake listening never silently dies.
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { ...audioBase, deviceId: { exact: micDeviceId } },
              video: false,
            });
          } catch {
            console.warn("[wakeword] selected mic unavailable — using system default");
          }
        }
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioBase, video: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (audioCtx.state === "suspended") await audioCtx.resume();
        source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(2048, 1, 1);

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          event.outputBuffer.getChannelData(0).fill(0); // never echo mic to speakers
          const n = input.length;
          if (n >= ring.length) {
            ring.set(input.subarray(n - ring.length));
            filled = ring.length;
          } else {
            ring.copyWithin(0, n); // shift left by n
            ring.set(input, ring.length - n);
            filled = Math.min(ring.length, filled + n);
          }
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
        timer = window.setInterval(predict, PREDICT_INTERVAL_MS);
        console.log(
          `[wakeword] 🎙️ listening for "Hey Iris" @ ${audioCtx.sampleRate}Hz — say it to test (watch scores below)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[wakeword] init failed", error);
        onErrorRef.current?.(message);
      }
    }

    init();

    return () => {
      cancelled = true;
      console.log("[wakeword] stopped listening");
      if (timer !== null) window.clearInterval(timer);
      try {
        processor?.disconnect();
        source?.disconnect();
      } catch {
        // best-effort
      }
      stream?.getTracks().forEach((track) => track.stop());
      audioCtx?.close().catch(() => undefined);
      // NOTE: ONNX sessions are cached module-level and intentionally NOT released
      // here, so re-arming after sleep is instant.
    };
  }, [enabled, threshold, micDeviceId]);
}
