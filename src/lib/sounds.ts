// Synthesized UI sounds — no audio assets, just tuned Web Audio tones with
// soft envelopes. Design language: rising intervals for wake/success, falling
// for sleep/failure, a gentle double-tap for attention. Everything is short
// (≤0.5s) and quiet by design.

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

const MASTER_GAIN = 0.22;

type ToneSpec = {
  freq: number;
  /** Seconds after the sound starts. */
  at?: number;
  dur?: number;
  type?: OscillatorType;
  peak?: number;
  /** Optional pitch glide target. */
  glideTo?: number;
};

function play(tones: ToneSpec[]) {
  try {
    const ac = audioCtx();
    const now = ac.currentTime + 0.02;
    const master = ac.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ac.destination);

    for (const tone of tones) {
      const { freq, at = 0, dur = 0.28, type = "sine", peak = 0.5, glideTo } = tone;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + at);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, now + at + dur * 0.7);

      // Click-free envelope: fast linear attack, exponential release.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.linearRampToValueAtTime(peak, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);

      osc.connect(gain);
      gain.connect(master);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.05);
    }
  } catch {
    // Sound is decoration; never let it break anything.
  }
}

/** Two-note rising chime with a faint octave shimmer. */
function wake() {
  play([
    { freq: 659.3, dur: 0.22, peak: 0.42 }, // E5
    { freq: 1318.5, dur: 0.22, peak: 0.08 },
    { freq: 987.8, at: 0.11, dur: 0.34, peak: 0.46 }, // B5
    { freq: 1975.5, at: 0.11, dur: 0.3, peak: 0.07 },
  ]);
}

/** Mirrored descending pair — softer and longer, "powering down". */
function sleep() {
  play([
    { freq: 493.9, dur: 0.26, peak: 0.34 }, // B4
    { freq: 329.6, at: 0.13, dur: 0.46, peak: 0.38 }, // E4
  ]);
}

/** Quick upward glide + tiny tick: something just left for Hermes. */
function taskSent() {
  play([
    { freq: 523.3, dur: 0.16, peak: 0.34, glideTo: 784 }, // C5 → G5
    { freq: 1568, at: 0.1, dur: 0.06, type: "triangle", peak: 0.12 },
  ]);
}

/** Warm two-note completion with a soft third on top. */
function taskDone() {
  play([
    { freq: 784, dur: 0.18, peak: 0.36 }, // G5
    { freq: 1046.5, at: 0.12, dur: 0.36, peak: 0.42 }, // C6
    { freq: 1318.5, at: 0.12, dur: 0.3, peak: 0.1 }, // E6 shimmer
  ]);
}

/** Gentle minor fall — something didn't work out. */
function taskFailed() {
  play([
    { freq: 440, dur: 0.2, peak: 0.3 }, // A4
    { freq: 311.1, at: 0.13, dur: 0.4, peak: 0.32 }, // Eb4
  ]);
}

/** Polite double-tap on one note — Hermes needs your attention. */
function approval() {
  play([
    { freq: 987.8, dur: 0.09, peak: 0.34 },
    { freq: 987.8, at: 0.15, dur: 0.12, peak: 0.38 },
    { freq: 1479.98, at: 0.15, dur: 0.12, peak: 0.08 },
  ]);
}

export const uiSounds = { wake, sleep, taskSent, taskDone, taskFailed, approval };
