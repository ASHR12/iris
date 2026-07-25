import { useEffect, useRef } from "react";
import { Camera } from "lucide-react";
import DevicePicker from "./DevicePicker";
import type { HandState } from "../hooks/useHandControl";

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
] as const;

export function HandSkeleton({ hands }: { hands: HandState["hands"] }) {
  if (!hands.length) return null;
  return (
    <svg className="hand-skeleton" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {hands.map((hand, handIndex) => (
        <g key={hand.id} className={handIndex > 0 ? "secondary" : ""}>
          {HAND_CONNECTIONS.map(([from, to]) => {
            const a = hand.landmarks[from];
            const b = hand.landmarks[to];
            if (!a || !b) return null;
            return (
              <line
                key={`${from}-${to}`}
                x1={a.x * 100}
                y1={a.y * 100}
                x2={b.x * 100}
                y2={b.y * 100}
              />
            );
          })}
          {hand.landmarks.map((landmark, index) => (
            <circle key={index} cx={landmark.x * 100} cy={landmark.y * 100} r={index === 8 ? 1.45 : 1.05} />
          ))}
        </g>
      ))}
    </svg>
  );
}

export default function CameraDock({
  handControl,
  hand,
  stream,
  error,
  actionLabel,
  actionTone,
  cameraDevice,
  onPickCameraDevice,
}: {
  handControl: boolean;
  hand: HandState;
  stream: MediaStream | null;
  error?: string | null;
  actionLabel: string;
  actionTone: string;
  cameraDevice: string;
  onPickCameraDevice: (id: string) => void;
}) {
  // Owns its own srcObject assignment so the feed survives remounts (e.g.
  // returning from HUD mode re-creates this video element).
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, handControl]);
  return (
    <section className={`deck-panel camera-dock ${handControl ? "" : "off"}`}>
      <div className="col-head">
        <Camera size={13} />
        <span>Camera / Gesture</span>
        {!handControl ? <span className="head-state">off</span> : null}
        {/* Right-aligned + opens downward: the menu overlays the camera feed
            itself, never the conversation text above the panel. */}
        <DevicePicker
          kind="videoinput"
          value={cameraDevice}
          onSelect={onPickCameraDevice}
          title="Select a camera"
          align="right"
        />
      </div>
      {handControl ? (
        <div className="camera-frame">
          <video ref={videoRef} autoPlay playsInline muted />
          <div className="cam-scan" />
          <HandSkeleton hands={hand.hands} />
          {error ? <span className="cam-error">{error}</span> : null}
          <span className="cam-status">
            <i />
            {hand.present ? "tracking" : "no hand"}
          </span>
          <span className={`gesture-chip ${actionTone}`}>
            <span className="dot" />
            {actionLabel}
          </span>
        </div>
      ) : (
        <div className="camera-off">Gesture control is off. Tap the hand icon to enable the camera.</div>
      )}
    </section>
  );
}
