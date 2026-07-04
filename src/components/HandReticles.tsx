import type { HandState } from "../hooks/useHandControl";

// Floating gesture cursors (one per tracked hand) rendered above everything.
export default function HandReticles({
  hand,
  dwelling,
}: {
  hand: HandState;
  dwelling: boolean;
}) {
  const items = hand.hands.length
    ? hand.hands
    : hand.point
      ? [{ ...hand, id: "hand-0", point: hand.point }]
      : [];

  return (
    <>
      {items.map((item, index) => {
        // While pinching, the cursor sits at the thumb-index grab point.
        const point = item.pinch && item.pinchPoint ? item.pinchPoint : item.point;
        // One tag per hand, always telling you what the system sees —
        // same logic for every gesture, color-matched to the ring.
        const isDwelling = index === 0 && dwelling;
        const label = item.pinch
          ? "PINCH"
          : item.fist
            ? "FIST"
            : item.openPalm
              ? "PALM"
              : item.pointing
                ? isDwelling
                  ? "HOLD"
                  : "POINT"
                : null;
        const tone = item.pinch ? "pinch" : item.fist ? "fist" : item.openPalm ? "open" : "pointing";
        return (
          <div
            key={item.id}
            className={`hand-reticle ${index > 0 ? "secondary" : ""} ${
              isDwelling ? "dwell" : ""
            } ${item.pointing ? "pointing" : ""} ${item.openPalm ? "open" : ""} ${item.fist ? "fist" : ""} ${
              item.pinch ? "pinch" : ""
            }`}
            style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
          >
            <span className="hand-ring" />
            <span className="hand-dot" />
            {label ? <span className={`hand-gesture-label ${tone}`}>{label}</span> : null}
          </div>
        );
      })}
    </>
  );
}
