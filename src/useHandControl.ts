import { useEffect, useState } from "react";
import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

export type HandPoint = { x: number; y: number };

export type HandState = {
  active: boolean;
  present: boolean;
  point: HandPoint | null;
  gesture: string;
  gestureScore: number;
  pointing: boolean;
  openPalm: boolean;
  fist: boolean;
};

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

// Camera coordinates rarely use the full 0..1 range in practice. Expand the
// useful center region to the full screen so reaching UI edges doesn't require
// moving your hand to the physical edge of the camera frame.
const INPUT_RANGE = {
  xMin: 0.18,
  xMax: 0.82,
  yMin: 0.12,
  yMax: 0.82,
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function remapToScreen(value: number, min: number, max: number, size: number) {
  return clamp01((value - min) / (max - min)) * size;
}

const EMPTY_STATE: HandState = {
  active: false,
  present: false,
  point: null,
  gesture: "None",
  gestureScore: 0,
  pointing: false,
  openPalm: false,
  fist: false,
};

/**
 * Camera hand tracking powered by MediaPipe GestureRecognizer.
 *
 * We rely on the edge ML model's canned classes instead of hand-written angle
 * heuristics. Supported classes include Closed_Fist, Open_Palm, Pointing_Up,
 * Thumb_Up, Thumb_Down, Victory, ILoveYou, and None.
 */
export function useHandControl(enabled: boolean) {
  const [state, setState] = useState<HandState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY_STATE);
      setStream(null);
      return;
    }

    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let recognizer: GestureRecognizer | null = null;
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;

    let smooth: HandPoint | null = null;
    let stableGesture = "None";
    let candidateGesture = "None";
    let candidateFrames = 0;

    async function setup() {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        recognizer = await GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
          cannedGesturesClassifierOptions: {
            scoreThreshold: 0.55,
          },
        });

        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
        });
        video.srcObject = stream;
        await video.play();

        if (cancelled) return;
        setStream(stream);
        setState({ ...EMPTY_STATE, active: true });
        loop();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    function stabilizeGesture(rawGesture: string) {
      if (rawGesture === candidateGesture) {
        candidateFrames = Math.min(candidateFrames + 1, 8);
      } else {
        candidateGesture = rawGesture;
        candidateFrames = 1;
      }
      if (candidateFrames >= 3) {
        stableGesture = candidateGesture;
      }
      return stableGesture;
    }

    function loop() {
      if (cancelled || !recognizer) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = recognizer.recognizeForVideo(video, now);
        const hand = result.landmarks?.[0];
        const topGesture = result.gestures?.[0]?.[0];

        if (hand && topGesture) {
          const score = topGesture.score ?? 0;
          const rawGesture = score >= 0.55 ? topGesture.categoryName ?? "None" : "None";
          const gesture = stabilizeGesture(rawGesture);
          const indexTip = hand[8];

          const mirroredX = 1 - indexTip.x;
          const raw: HandPoint = {
            x: remapToScreen(mirroredX, INPUT_RANGE.xMin, INPUT_RANGE.xMax, window.innerWidth),
            y: remapToScreen(indexTip.y, INPUT_RANGE.yMin, INPUT_RANGE.yMax, window.innerHeight),
          };
          smooth = smooth
            ? { x: smooth.x + (raw.x - smooth.x) * 0.5, y: smooth.y + (raw.y - smooth.y) * 0.5 }
            : raw;

          const pointing = gesture === "Pointing_Up";
          const openPalm = gesture === "Open_Palm";
          const fist = gesture === "Closed_Fist";
          setState({
            active: true,
            present: true,
            point: smooth,
            gesture,
            gestureScore: score,
            pointing,
            openPalm,
            fist,
          });
        } else {
          smooth = null;
          candidateGesture = "None";
          candidateFrames = 0;
          stableGesture = "None";
          setState({ ...EMPTY_STATE, active: true });
        }
      }
      raf = requestAnimationFrame(loop);
    }

    setup();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      recognizer?.close();
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      setStream(null);
    };
  }, [enabled]);

  return { state, error, stream };
}
