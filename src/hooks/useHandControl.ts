import { useEffect, useState } from "react";
import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

export type HandPoint = { x: number; y: number };
export type HandLandmark = { x: number; y: number };

export type TrackedHand = {
  id: string;
  point: HandPoint;
  landmarks: HandLandmark[];
  gesture: string;
  gestureScore: number;
  pointing: boolean;
  openPalm: boolean;
  fist: boolean;
  /** Thumb + index tips held together (landmark-derived, not a canned class). */
  pinch: boolean;
  /** Screen-space midpoint of thumb and index tips — the "grab" location. */
  pinchPoint: HandPoint;
};

export type HandState = {
  active: boolean;
  present: boolean;
  point: HandPoint | null;
  gesture: string;
  gestureScore: number;
  pointing: boolean;
  openPalm: boolean;
  fist: boolean;
  pinch: boolean;
  pinchPoint: HandPoint | null;
  hands: TrackedHand[];
};

// Keep this version in sync with the @mediapipe/tasks-vision version in
// package.json to avoid runtime/ABI mismatches between the JS API and the WASM.
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
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
  pinch: false,
  pinchPoint: null,
  hands: [],
};

// Pinch = thumb tip (4) touching index tip (8), measured against hand size
// (wrist 0 -> middle MCP 9) so it works at any distance from the camera.
//
// A bare distance check false-fires constantly: a relaxed hand, and every
// palm<->fist transition, passes through "tips close". The rule is symmetric
// and predictable: YOU HOLD THE OK-SIGN, IT HOLDS THE GRAB.
//
// Engage (all, for several consecutive frames):
//   1. tips truly touching (tight threshold),
//   2. the hand is NOT a fist (canned class),
//   3. at least two of middle/ring/pinky reach away from the wrist
//      (the OK-sign pose — a curled or relaxed hand fails this).
// Release (any, with a short grace for classifier noise):
//   tips clearly apart · the OK-sign collapses (fingers curl/relax) · fist.
// The release pose thresholds are looser than entry (hysteresis) so a held
// drag doesn't stutter — but simply relaxing the hand ALWAYS lets go.
const PINCH_ENTER = 0.26;
const PINCH_EXIT = 0.36;
const PINCH_HOLD_FRAMES = 4;
const PINCH_RELEASE_FRAMES = 3;
const EXTENDED_TIP_SPAN = 1.1;
const EXTENDED_TIP_SPAN_HOLD = 0.95;

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
    let primaryId = "";
    let primaryPoint: HandPoint | null = null;
    const stableGestureById = new Map<string, string>();
    const candidateGestureById = new Map<string, string>();
    const candidateFramesById = new Map<string, number>();
    const pinchById = new Map<string, boolean>();
    const pinchHoldById = new Map<string, number>();
    const pinchReleaseById = new Map<string, number>();
    const pinchSmoothById = new Map<string, HandPoint>();

    async function setup() {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        recognizer = await GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
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

    function stabilizeGesture(id: string, rawGesture: string) {
      const candidateGesture = candidateGestureById.get(id) ?? "None";
      const candidateFrames = candidateFramesById.get(id) ?? 0;
      if (rawGesture === candidateGesture) {
        candidateFramesById.set(id, Math.min(candidateFrames + 1, 8));
      } else {
        candidateGestureById.set(id, rawGesture);
        candidateFramesById.set(id, 1);
      }
      if ((candidateFramesById.get(id) ?? 0) >= 3) {
        stableGestureById.set(id, rawGesture);
      }
      return stableGestureById.get(id) ?? "None";
    }

    function nearestTo(point: HandPoint, hands: TrackedHand[]) {
      return hands.reduce((best, hand) => {
        const bestDistance = Math.hypot(best.point.x - point.x, best.point.y - point.y);
        const handDistance = Math.hypot(hand.point.x - point.x, hand.point.y - point.y);
        return handDistance < bestDistance ? hand : best;
      }, hands[0]);
    }

    function choosePrimary(hands: TrackedHand[]) {
      const pointingHands = hands.filter((hand) => hand.pointing);
      const previous = hands.find((hand) => hand.id === primaryId);

      // If only one hand is intentionally pointing, switch to it immediately.
      // This fixes the "wrong hand stays primary" issue when both hands are visible.
      if (pointingHands.length === 1) return pointingHands[0];

      // If both point, avoid flicker by keeping the existing primary if possible.
      if (pointingHands.length > 1) {
        const previousPointing = pointingHands.find((hand) => hand.id === primaryId);
        if (previousPointing) return previousPointing;
        if (primaryPoint) return nearestTo(primaryPoint, pointingHands);
        return pointingHands[0];
      }

      // No pointing hand: preserve continuity for scroll/resize/read states.
      if (previous) return previous;
      if (primaryPoint) return nearestTo(primaryPoint, hands);
      return hands[0];
    }

    function loop() {
      if (cancelled || !recognizer) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = recognizer.recognizeForVideo(video, now);
        const landmarks = result.landmarks ?? [];
        const gestures = result.gestures ?? [];

        if (landmarks.length > 0) {
          const detected = landmarks.slice(0, 2).map((hand, index) => {
            const topGesture = gestures[index]?.[0];
            const score = topGesture?.score ?? 0;
            const rawGesture = score >= 0.55 ? topGesture?.categoryName ?? "None" : "None";
            const indexTip = hand[8];
            const mirroredX = 1 - indexTip.x;
            const point = {
              x: remapToScreen(mirroredX, INPUT_RANGE.xMin, INPUT_RANGE.xMax, window.innerWidth),
              y: remapToScreen(indexTip.y, INPUT_RANGE.yMin, INPUT_RANGE.yMax, window.innerHeight),
            };
            return {
              rawGesture,
              score,
              point,
              landmarks: hand.map((landmark) => ({ x: 1 - landmark.x, y: landmark.y })),
            };
          });

          const byX = [...detected].sort((a, b) => a.point.x - b.point.x);
          const hands: TrackedHand[] = detected.map((hand) => {
            const id = detected.length === 1 ? "single" : hand === byX[0] ? "left" : "right";
            const gesture = stabilizeGesture(id, hand.rawGesture);

            // Landmark-derived pinch: strict, multi-signal entry (see the
            // constant block above) so relaxed hands and palm<->fist
            // transitions can never grab; sticky hold once engaged.
            const lm = hand.landmarks;
            const handSpan = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1;
            const tipGap = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / handSpan;
            const reach = (tip: number) => Math.hypot(lm[tip].x - lm[0].x, lm[tip].y - lm[0].y) / handSpan;
            const wasPinching = pinchById.get(id) ?? false;
            let pinch = wasPinching;
            if (!wasPinching) {
              const extendedCount = [12, 16, 20].filter((tip) => reach(tip) > EXTENDED_TIP_SPAN).length;
              const qualifies = tipGap < PINCH_ENTER && extendedCount >= 2 && gesture !== "Closed_Fist";
              const hold = qualifies ? (pinchHoldById.get(id) ?? 0) + 1 : 0;
              pinchHoldById.set(id, hold);
              if (hold >= PINCH_HOLD_FRAMES) {
                pinch = true;
                pinchReleaseById.set(id, 0);
              }
            } else {
              // Same pose requirements as entry (looser thresholds): if the
              // OK-sign collapses — fingers curl in, hand relaxes, or the
              // tips part — the grab lets go after a short grace.
              const extendedHold = [12, 16, 20].filter((tip) => reach(tip) > EXTENDED_TIP_SPAN_HOLD).length;
              const stillHolding = tipGap < PINCH_EXIT && extendedHold >= 2 && gesture !== "Closed_Fist";
              const misses = stillHolding ? 0 : (pinchReleaseById.get(id) ?? 0) + 1;
              pinchReleaseById.set(id, misses);
              if (misses >= PINCH_RELEASE_FRAMES) {
                pinch = false;
                pinchHoldById.set(id, 0);
              }
            }
            pinchById.set(id, pinch);
            const rawPinchPoint = {
              x: remapToScreen((lm[4].x + lm[8].x) / 2, INPUT_RANGE.xMin, INPUT_RANGE.xMax, window.innerWidth),
              y: remapToScreen((lm[4].y + lm[8].y) / 2, INPUT_RANGE.yMin, INPUT_RANGE.yMax, window.innerHeight),
            };
            const prevSmooth = pinch ? pinchSmoothById.get(id) : undefined;
            const pinchPoint = prevSmooth
              ? {
                  x: prevSmooth.x + (rawPinchPoint.x - prevSmooth.x) * 0.55,
                  y: prevSmooth.y + (rawPinchPoint.y - prevSmooth.y) * 0.55,
                }
              : rawPinchPoint;
            if (pinch) pinchSmoothById.set(id, pinchPoint);
            else pinchSmoothById.delete(id);

            return {
              id,
              point: hand.point,
              landmarks: hand.landmarks,
              gesture,
              gestureScore: hand.score,
              pointing: gesture === "Pointing_Up",
              openPalm: gesture === "Open_Palm",
              fist: gesture === "Closed_Fist",
              pinch,
              pinchPoint,
            };
          });

          const primary = choosePrimary(hands);
          primaryId = primary.id;
          smooth = smooth
            ? {
                x: smooth.x + (primary.point.x - smooth.x) * 0.5,
                y: smooth.y + (primary.point.y - smooth.y) * 0.5,
              }
            : primary.point;
          primaryPoint = smooth;

          setState({
            active: true,
            present: true,
            point: smooth,
            gesture: primary.gesture,
            gestureScore: primary.gestureScore,
            pointing: primary.pointing,
            openPalm: primary.openPalm,
            fist: primary.fist,
            pinch: primary.pinch,
            pinchPoint: primary.pinch ? primary.pinchPoint : null,
            hands: hands.map((item) => (item === primary ? { ...item, point: smooth! } : item)),
          });
        } else {
          smooth = null;
          primaryId = "";
          primaryPoint = null;
          stableGestureById.clear();
          candidateGestureById.clear();
          candidateFramesById.clear();
          pinchById.clear();
          pinchHoldById.clear();
          pinchReleaseById.clear();
          pinchSmoothById.clear();
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
