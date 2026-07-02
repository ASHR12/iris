import { useEffect, useRef } from "react";

type ReactorState = "idle" | "online" | "listening" | "speaking" | "working";

type Palette = {
  primary: string;
  secondary: string;
  accent: string;
  glow: string;
};

const PALETTES: Record<ReactorState, Palette> = {
  idle: { primary: "120, 170, 150", secondary: "150, 185, 165", accent: "210, 225, 218", glow: "150, 205, 180" },
  online: { primary: "18, 163, 148", secondary: "70, 200, 175", accent: "230, 255, 248", glow: "60, 195, 170" },
  listening: { primary: "40, 205, 170", secondary: "18, 163, 148", accent: "236, 255, 250", glow: "70, 214, 185" },
  speaking: { primary: "238, 122, 92", secondary: "255, 188, 108", accent: "255, 250, 230", glow: "255, 154, 104" },
  working: { primary: "120, 180, 120", secondary: "40, 200, 170", accent: "252, 255, 230", glow: "130, 195, 150" },
};

function drawArc(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  start: number,
  end: number,
  color: string,
  width: number,
  alpha = 1,
  blur = 0,
) {
  c.beginPath();
  c.strokeStyle = `rgba(${color}, ${alpha})`;
  c.lineWidth = width;
  c.lineCap = "round";
  c.shadowColor = `rgba(${color}, ${alpha})`;
  c.shadowBlur = blur;
  c.arc(x, y, r, start, end);
  c.stroke();
  c.shadowBlur = 0;
}

export default function ReactorCore({
  state,
  levelRef,
  inputLevelRef,
  outputLevelRef,
  thinking = false,
  wakeKey = 0,
  rippleKey = 0,
}: {
  state: ReactorState;
  /** Legacy combined level (still honored if the split refs are not given). */
  levelRef?: { current: number };
  /** Mic level — drives the sharp radial-bar "you are talking" signature. */
  inputLevelRef?: { current: number };
  /** Playback level — drives the smooth-wave "Iris is talking" signature. */
  outputLevelRef?: { current: number };
  /** Orbiting "thinking" swirl (the gap between your words and Iris's voice). */
  thinking?: boolean;
  /** Increment to fire the wake double-pulse. */
  wakeKey?: number;
  /** Increment to fire a single "understood you" ripple. */
  rippleKey?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ReactorState>(state);
  const energyRef = useRef(0);
  const liveRef = useRef(0);
  const inRef = useRef(0);
  const outRef = useRef(0);
  const thinkingRef = useRef(thinking);
  const thinkingAlphaRef = useRef(0);
  const ripplesRef = useRef<Array<{ start: number; kind: "wake" | "heard" }>>([]);
  const boostRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  // Wake: two quick expanding rings + a temporary energy surge.
  useEffect(() => {
    if (!wakeKey) return;
    ripplesRef.current.push({ start: performance.now(), kind: "wake" });
    boostRef.current = 0.5;
    const second = window.setTimeout(() => {
      ripplesRef.current.push({ start: performance.now(), kind: "wake" });
    }, 170);
    return () => window.clearTimeout(second);
  }, [wakeKey]);

  // "Understood you": one soft ripple as your words are locked in.
  useEffect(() => {
    if (!rippleKey) return;
    ripplesRef.current.push({ start: performance.now(), kind: "heard" });
  }, [rippleKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const element: HTMLCanvasElement = canvas;
    const c: CanvasRenderingContext2D = ctx;

    let raf = 0;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const rect = element.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      element.width = Math.floor(width * dpr);
      element.height = Math.floor(height * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    function targetEnergy(s: ReactorState) {
      if (s === "speaking") return 1;
      if (s === "working") return 0.88;
      if (s === "listening") return 0.72;
      if (s === "online") return 0.45;
      return 0.18;
    }

    function draw(time: number) {
      const s = stateRef.current;
      const palette = PALETTES[s];
      energyRef.current += (targetEnergy(s) - energyRef.current) * 0.06;
      // Live audio levels react fast on top of the smooth base energy so the
      // core visibly breathes with the actual voice. Mic and playback are
      // tracked separately for the two voice signatures.
      const inTarget = inputLevelRef ? Math.max(0, Math.min(1, inputLevelRef.current)) : 0;
      const outTarget = outputLevelRef ? Math.max(0, Math.min(1, outputLevelRef.current)) : 0;
      inRef.current += (inTarget - inRef.current) * 0.35;
      outRef.current += (outTarget - outRef.current) * 0.35;
      const legacyTarget = levelRef ? Math.max(0, Math.min(1, levelRef.current)) : 0;
      liveRef.current += (legacyTarget - liveRef.current) * 0.35;
      const inLive = inRef.current;
      const outLive = outRef.current;
      const live = Math.max(liveRef.current, inLive, outLive);
      boostRef.current *= 0.945; // wake surge decays over ~1s
      const energy = Math.min(1, energyRef.current + live * 0.6 + boostRef.current);
      const t = time / 1000;

      const cx = width / 2;
      const cy = height / 2;
      const base = Math.min(width, height) / 2;
      const unit = base * 0.86;

      c.clearRect(0, 0, width, height);

      // Soft reactor halo
      const halo = c.createRadialGradient(cx, cy, 0, cx, cy, base * 0.95);
      halo.addColorStop(0, `rgba(${palette.glow}, ${0.32 + energy * 0.24})`);
      halo.addColorStop(0.34, `rgba(${palette.glow}, ${0.12 + energy * 0.08})`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = halo;
      c.beginPath();
      c.arc(cx, cy, base * 0.95, 0, Math.PI * 2);
      c.fill();

      // Outer micro ticks (futuristic HUD radial scale)
      const tickCount = 144;
      for (let i = 0; i < tickCount; i++) {
        const a = (i / tickCount) * Math.PI * 2;
        const major = i % 12 === 0;
        const medium = i % 6 === 0;
        const outer = unit * 0.93;
        const inner = outer - (major ? 18 : medium ? 12 : 6);
        const alpha = major ? 0.46 : medium ? 0.28 : 0.14;
        c.beginPath();
        c.strokeStyle = `rgba(${palette.primary}, ${alpha})`;
        c.lineWidth = major ? 1.4 : 0.8;
        c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        c.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        c.stroke();
      }

      // Segmented outer ring
      const segments = 28;
      const segR = unit * 0.78;
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2 + t * 0.08;
        const len = Math.PI * 2 / segments * 0.56;
        const active = (i + Math.floor(t * 2)) % 7 === 0;
        drawArc(c, cx, cy, segR, a, a + len, palette.primary, active ? 3 : 1.4, active ? 0.88 : 0.34, active ? 10 : 0);
      }

      // Counter-rotating scan arcs
      const scanA = t * (0.65 + energy * 0.4);
      drawArc(c, cx, cy, unit * 0.66, scanA, scanA + Math.PI * 0.72, palette.secondary, 3.4, 0.9, 14);
      drawArc(c, cx, cy, unit * 0.66, scanA + Math.PI * 1.08, scanA + Math.PI * 1.45, palette.secondary, 1.7, 0.45, 6);

      const scanB = -t * 0.42;
      drawArc(c, cx, cy, unit * 0.54, scanB, scanB + Math.PI * 0.95, palette.primary, 2.2, 0.58, 8);
      drawArc(c, cx, cy, unit * 0.42, -scanA * 0.8, -scanA * 0.8 + Math.PI * 1.24, palette.primary, 1.4, 0.34, 4);

      // Technical hexagon and triangular reactor guides
      c.save();
      c.translate(cx, cy);
      c.rotate(t * 0.08);
      c.strokeStyle = `rgba(${palette.primary}, ${0.25 + energy * 0.12})`;
      c.lineWidth = 1.2;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const x = Math.cos(a) * unit * 0.32;
        const y = Math.sin(a) * unit * 0.32;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.stroke();

      c.strokeStyle = `rgba(${palette.secondary}, ${0.18 + energy * 0.1})`;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        c.beginPath();
        c.moveTo(Math.cos(a) * unit * 0.17, Math.sin(a) * unit * 0.17);
        c.lineTo(Math.cos(a) * unit * 0.5, Math.sin(a) * unit * 0.5);
        c.stroke();
      }
      c.restore();

      // Middle segmented circuit ring
      const circuitSegments = 18;
      const circuitR = unit * 0.36;
      for (let i = 0; i < circuitSegments; i++) {
        const a = (i / circuitSegments) * Math.PI * 2 - t * 0.12;
        const len = Math.PI * 2 / circuitSegments * 0.42;
        drawArc(c, cx, cy, circuitR, a, a + len, palette.primary, 1.2, 0.38, 0);
      }

      // Core rings
      const pulse = 1 + Math.sin(t * 4) * 0.035 * (0.3 + energy);
      const coreR = unit * 0.18 * pulse;
      const coreGlow = c.createRadialGradient(cx, cy, 0, cx, cy, unit * 0.36);
      coreGlow.addColorStop(0, `rgba(${palette.accent}, 1)`);
      coreGlow.addColorStop(0.22, `rgba(${palette.primary}, ${0.78 + energy * 0.18})`);
      coreGlow.addColorStop(0.48, `rgba(${palette.glow}, ${0.24 + energy * 0.18})`);
      coreGlow.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = coreGlow;
      c.beginPath();
      c.arc(cx, cy, unit * 0.36, 0, Math.PI * 2);
      c.fill();

      c.beginPath();
      c.fillStyle = `rgba(${palette.accent}, 0.94)`;
      c.shadowColor = `rgba(${palette.primary}, 0.9)`;
      c.shadowBlur = 30;
      c.arc(cx, cy, coreR * 0.45, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;

      drawArc(c, cx, cy, coreR, 0, Math.PI * 2, palette.accent, 1.4, 0.85, 8);
      drawArc(c, cx, cy, coreR * 1.72, t * 0.6, t * 0.6 + Math.PI * 1.65, palette.primary, 1.3, 0.5, 5);

      // Legacy combined voice ring (only when the split refs are not wired,
      // e.g. the boot screen orb).
      if (!inputLevelRef && !outputLevelRef && live > 0.01) {
        const reactR = unit * (0.46 + live * 0.34);
        drawArc(c, cx, cy, reactR, 0, Math.PI * 2, palette.secondary, 1 + live * 3, 0.18 + live * 0.6, live * 18);
      }

      // ===== Micro-expressions (additive layers; the core above is untouched) =====

      // YOUR voice: sharp radial bars, like a spectral halo around the orb.
      if (inLive > 0.025) {
        const bars = 56;
        const baseR = unit * 0.5;
        const alpha = Math.min(0.85, inLive * 2.4);
        c.lineCap = "round";
        for (let i = 0; i < bars; i++) {
          const a = (i / bars) * Math.PI * 2 + t * 0.06;
          const jitter =
            0.55 + 0.45 * Math.sin(i * 3.7 + t * 11.3) + 0.25 * Math.sin(i * 1.31 - t * 7.1);
          const len = 3 + inLive * 42 * Math.max(0.08, jitter);
          c.beginPath();
          c.strokeStyle = `rgba(${palette.secondary}, ${alpha})`;
          c.lineWidth = 1.8;
          c.moveTo(cx + Math.cos(a) * baseR, cy + Math.sin(a) * baseR);
          c.lineTo(cx + Math.cos(a) * (baseR + len), cy + Math.sin(a) * (baseR + len));
          c.stroke();
        }
      }

      // IRIS's voice: a smooth breathing wave ring (low harmonics, soft glow).
      if (outLive > 0.025) {
        const points = 120;
        const baseR = unit * 0.6;
        const amp = unit * (0.025 + 0.15 * outLive);
        const waveAlpha = 0.22 + outLive * 0.6;
        for (let echo = 0; echo < 2; echo++) {
          c.beginPath();
          for (let i = 0; i <= points; i++) {
            const th = (i / points) * Math.PI * 2;
            const r =
              baseR * (echo ? 0.92 : 1) +
              amp *
                (0.5 * Math.sin(3 * th + t * 2.2 + echo) +
                  0.32 * Math.sin(5 * th - t * 2.9) +
                  0.18 * Math.sin(9 * th + t * 1.6));
            const x = cx + Math.cos(th) * r;
            const y = cy + Math.sin(th) * r;
            if (i === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
          }
          c.closePath();
          c.strokeStyle = `rgba(${palette.primary}, ${echo ? waveAlpha * 0.35 : waveAlpha})`;
          c.lineWidth = echo ? 1.4 : 2.6;
          c.shadowColor = `rgba(${palette.glow}, ${waveAlpha})`;
          c.shadowBlur = echo ? 0 : 12;
          c.stroke();
          c.shadowBlur = 0;
        }
      }

      // Thinking swirl: two orbiting sparks with comet tails while Iris forms
      // its reply (eased in/out so it never pops).
      thinkingAlphaRef.current += ((thinkingRef.current ? 1 : 0) - thinkingAlphaRef.current) * 0.07;
      const thinkAlpha = thinkingAlphaRef.current;
      if (thinkAlpha > 0.02) {
        const orbitR = unit * 0.29;
        for (let k = 0; k < 2; k++) {
          const a = t * 2.7 + k * Math.PI;
          drawArc(c, cx, cy, orbitR, a - 0.85, a, palette.secondary, 2.2, 0.5 * thinkAlpha, 6);
          const hx = cx + Math.cos(a) * orbitR;
          const hy = cy + Math.sin(a) * orbitR;
          c.beginPath();
          c.fillStyle = `rgba(${palette.accent}, ${0.9 * thinkAlpha})`;
          c.shadowColor = `rgba(${palette.glow}, ${0.9 * thinkAlpha})`;
          c.shadowBlur = 10;
          c.arc(hx, hy, 2.6, 0, Math.PI * 2);
          c.fill();
          c.shadowBlur = 0;
        }
        drawArc(c, cx, cy, orbitR, 0, Math.PI * 2, palette.primary, 0.8, 0.14 * thinkAlpha, 0);
      }

      // Ripples: wake double-pulse (bolder) and the "understood you" ring.
      const nowMs = performance.now();
      ripplesRef.current = ripplesRef.current.filter((ripple) => {
        const life = ripple.kind === "wake" ? 750 : 620;
        const p = (nowMs - ripple.start) / life;
        if (p >= 1) return false;
        const ease = 1 - Math.pow(1 - p, 3);
        const r = unit * (0.24 + (ripple.kind === "wake" ? 0.72 : 0.5) * ease);
        const alpha = (1 - p) * (ripple.kind === "wake" ? 0.75 : 0.5);
        const color = ripple.kind === "wake" ? palette.secondary : palette.accent;
        drawArc(c, cx, cy, r, 0, Math.PI * 2, color, 2.6 - 1.6 * p, alpha, 10 * (1 - p));
        return true;
      });

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="reactor-canvas" />;
}
