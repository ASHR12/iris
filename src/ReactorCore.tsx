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

export default function ReactorCore({ state }: { state: ReactorState }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ReactorState>(state);
  const energyRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
      const energy = energyRef.current;
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

      // Outer micro ticks (JARVIS-style radial scale)
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
