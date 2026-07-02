import { useEffect, useRef, useState, type RefObject } from "react";
import type { HandoffTone, Pulse, TaskCard } from "../types";
import { TERMINAL, acceptedKey } from "../lib/tasks";

/**
 * Purely-visual delegation handoff effects (orb <-> Work Stream): comet pulses,
 * orb flashes, and the transient "task submitted" stamp. Diffs the tasks array to
 * detect delegation/completion; never mutates task state.
 */
export function useHandoffFx(
  tasks: TaskCard[],
  orbStageRef: RefObject<HTMLDivElement | null>,
  workScrollRef: RefObject<HTMLDivElement | null>,
  callbacks?: {
    /** A new run was delegated (comet flies out). */
    onDelegate?: () => void;
    /** A run reached a terminal state (comet flies back). */
    onComplete?: (tone: HandoffTone) => void;
  },
) {
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [orbFlash, setOrbFlash] = useState<{ id: string; tone: HandoffTone } | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Record<string, number>>({});
  const taskStatusRef = useRef<Map<string, string>>(new Map());
  const lastDelegationRef = useRef<Map<string, number>>(new Map());

  function centerOf(el: HTMLElement | null): { x: number; y: number } | null {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Where a Hermes card lives in the Work Stream: prefer the actual card, fall
  // back to the top of the work column for brand-new (not yet expandable) runs.
  function workStreamPoint(taskId: string): { x: number; y: number } | null {
    const card = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (card) return centerOf(card);
    const panel = workScrollRef.current;
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 46 };
  }

  function flashOrb(tone: HandoffTone) {
    setOrbFlash({ id: crypto.randomUUID(), tone });
  }

  function spawnPulse(
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null,
    kind: "out" | "in",
    tone: HandoffTone,
  ) {
    if (!from || !to) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const lift = Math.min(150, Math.max(40, dist * 0.22));
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    setPulses((current) => [
      ...current,
      { id: crypto.randomUUID(), kind, tone, fromX: from.x, fromY: from.y, dx, dy, lift, angle },
    ]);
  }

  // Gemini delegates -> orb flashes amber, a comet flies to the Work Stream, and
  // the card stamps "task submitted" as the comet lands.
  function handoffOut(task: TaskCard) {
    flashOrb("amber");
    callbacks?.onDelegate?.();
    spawnPulse(centerOf(orbStageRef.current), workStreamPoint(task.id), "out", "amber");
    // Key the stamp by task TEXT, not id: Hermes swaps the placeholder
    // ("starting:…") card for the real run_id card right after submit, so an
    // id-keyed flag would land on a card that no longer exists.
    const key = acceptedKey(task.task);
    window.setTimeout(() => {
      setAcceptedIds((current) => ({ ...current, [key]: Date.now() }));
      window.setTimeout(() => {
        setAcceptedIds((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }, 3200);
    }, 560);
  }

  // Hermes finishes -> a comet flies from the card back to the orb, then the orb
  // flashes (teal for success, coral for failure) as it arrives.
  function handoffIn(task: TaskCard) {
    const tone: HandoffTone = TERMINAL.has(task.status.toLowerCase())
      ? task.error || task.status.toLowerCase().includes("fail") || task.status.toLowerCase().includes("error")
        ? "error"
        : "success"
      : "success";
    spawnPulse(workStreamPoint(task.id), centerOf(orbStageRef.current), "in", tone);
    callbacks?.onComplete?.(tone);
    window.setTimeout(() => flashOrb(tone), 680);
  }

  // Handoff detector: diff the tasks array to know when Gemini delegated a new
  // run (one card appears) and when a run completes (active -> terminal). A bulk
  // load (e.g. demo/history fixture) adds many cards at once, so we only animate
  // single-card deltas.
  useEffect(() => {
    const prev = taskStatusRef.current;
    const added = tasks.filter((task) => !prev.has(task.id));

    for (const task of tasks) {
      const before = prev.get(task.id);
      const now = task.status.toLowerCase();
      if (before && !TERMINAL.has(before) && TERMINAL.has(now)) {
        handoffIn(task);
      }
    }

    if (added.length === 1) {
      const task = added[0];
      if (!TERMINAL.has(task.status.toLowerCase())) {
        const key = task.task.toLowerCase().trim();
        const last = lastDelegationRef.current.get(key) ?? 0;
        // Dedupe the "starting:" placeholder -> real run_id swap.
        if (Date.now() - last > 5000) {
          lastDelegationRef.current.set(key, Date.now());
          handoffOut(task);
        }
      }
    }

    const next = new Map<string, string>();
    for (const task of tasks) next.set(task.id, task.status.toLowerCase());
    taskStatusRef.current = next;
  }, [tasks]);

  function removePulse(id: string) {
    setPulses((current) => current.filter((item) => item.id !== id));
  }

  function clearOrbFlash() {
    setOrbFlash(null);
  }

  return { pulses, removePulse, orbFlash, clearOrbFlash, acceptedIds };
}
