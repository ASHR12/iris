import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Wrench, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskCard } from "../types";
import { normalizeMarkdown, shortRunId } from "../lib/tasks";
import type { HandState } from "../hooks/useHandControl";
import { StepTimeline } from "./WorkCard";

export default function ReaderOverlay({
  task,
  hand,
  stepsOpen = false,
  onToggleSteps,
  onClose,
}: {
  task: TaskCard;
  hand: HandState | null;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [readerScale, setReaderScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stepsListRef = useRef<HTMLDivElement | null>(null);
  const handRef = useRef<HandState | null>(hand);
  const readerScaleRef = useRef(1);
  const zoomRef = useRef<{ distance: number; scale: number } | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  handRef.current = hand;

  const CLOSE_DISTANCE = 160;

  function closeWithSnap() {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeWithSnap();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing, onClose]);

  useEffect(() => {
    if (hand?.fist) closeWithSnap();
  }, [hand?.fist]);

  // Joystick-style hold-to-scroll: with an open palm, holding the hand above the
  // card's center scrolls up, below scrolls down, and the middle is a dead zone.
  // Two open palms control reader scale instead.
  useEffect(() => {
    let raf = 0;
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const loop = () => {
      const h = handRef.current;
      const body = bodyRef.current;
      const openHands = h?.hands.filter((item) => item.openPalm && item.point) ?? [];
      if (openHands.length >= 2) {
        const currentDistance = distance(openHands[0].point, openHands[1].point);
        if (!zoomRef.current) {
          zoomRef.current = { distance: currentDistance, scale: readerScaleRef.current };
        }
        const ratio = currentDistance / Math.max(80, zoomRef.current.distance);
        const next = Math.max(0.72, Math.min(1.28, zoomRef.current.scale * ratio));
        if (Math.abs(next - readerScaleRef.current) > 0.004) {
          readerScaleRef.current = next;
          setReaderScale(next);
        }
      } else {
        zoomRef.current = null;
      }

      if (openHands.length < 2 && h?.openPalm && h.point && body) {
        // Scroll whichever region the palm hovers: the steps list if the hand
        // is over it, otherwise the main body.
        const steps = stepsListRef.current;
        const overSteps = (() => {
          if (!steps) return false;
          const r = steps.getBoundingClientRect();
          return (
            h.point.x >= r.left && h.point.x <= r.right && h.point.y >= r.top && h.point.y <= r.bottom
          );
        })();
        const target = overSteps && steps ? steps : body;
        const rect = target.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const deadZone = Math.max(24, rect.height * 0.12);
        const delta = h.point.y - center;
        if (Math.abs(delta) > deadZone) {
          const reach = rect.height / 2 - deadZone;
          const norm = Math.max(-1, Math.min(1, (delta - Math.sign(delta) * deadZone) / reach));
          target.scrollTop += norm * 26;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function beginDrag(clientX: number, clientY: number, target: HTMLElement, pointerId: number) {
    startRef.current = { x: clientX, y: clientY };
    setDragging(true);
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  }

  function moveDrag(clientX: number, clientY: number) {
    if (!startRef.current) return;
    setOffset({ x: clientX - startRef.current.x, y: clientY - startRef.current.y });
  }

  function endDrag() {
    if (!startRef.current) return;
    const distance = Math.hypot(offset.x, offset.y);
    startRef.current = null;
    setDragging(false);
    if (distance > CLOSE_DISTANCE) {
      closeWithSnap();
    } else {
      setOffset({ x: 0, y: 0 });
    }
  }

  const dim = Math.min(1, Math.hypot(offset.x, offset.y) / (CLOSE_DISTANCE * 2));

  return (
    <div
      className={`reader-backdrop ${closing ? "closing" : ""}`}
      style={{ opacity: 1 - dim * 0.6 }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeWithSnap();
      }}
    >
      <article
        className={`reader-card ${dragging ? "dragging" : ""} ${closing ? "closing" : ""}`}
        style={{
          "--reader-transform": `translate(${offset.x}px, ${offset.y}px) scale(${readerScale * (1 - dim * 0.08)})`,
        } as CSSProperties}
      >
        <header
          className="reader-grab"
          onPointerDown={(event) =>
            beginDrag(event.clientX, event.clientY, event.currentTarget, event.pointerId)
          }
          onPointerMove={(event) => dragging && moveDrag(event.clientX, event.clientY)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="reader-grip" />
          <span className={`badge ${task.status.toLowerCase()}`}>{task.status}</span>
          <code title={task.id}>{shortRunId(task.id)}</code>
          <button
            className="reader-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={closeWithSnap}
            title="Close"
          >
            <X size={16} />
          </button>
        </header>
        <h2 className="reader-title">{task.task}</h2>
        {task.steps?.length ? (
          <div className="reader-steps">
            <button
              type="button"
              className={`activity-toggle ${stepsOpen ? "open" : ""}`}
              onClick={() => onToggleSteps?.()}
            >
              <Wrench size={11} />
              {task.steps.length} step{task.steps.length === 1 ? "" : "s"} Hermes took
              <ChevronDown size={12} className="chev" />
            </button>
            {stepsOpen ? (
              <div className="reader-steps-list" ref={stepsListRef}>
                <StepTimeline steps={task.steps} />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="reader-body" ref={bodyRef}>
          <div className={`markdown-body ${task.error ? "error" : ""}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      if (href) void window.iris.openExternal(href);
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {normalizeMarkdown(task.error || task.output)}
            </ReactMarkdown>
          </div>
        </div>
        <div className="reader-hint">
          {hand
            ? "Open palm — hold high/low to scroll · Two open palms resize · Fist to close"
            : "Scroll to read · Esc or × to close"}
        </div>
      </article>
    </div>
  );
}
