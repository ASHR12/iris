import { useEffect, useRef, useState } from "react";
import { base64ToBytes, downsampleTo16k, parsePcmRate } from "../lib/audio";

/**
 * Owns the whole browser audio path:
 * - WebRTC mic capture (echo-cancelled) downsampled to 16 kHz PCM -> Electron main
 * - Gemini 24 kHz PCM playback through AudioContext (with barge-in flush)
 * - passive RMS meters (mic in vs Gemini out, separately) for the orb's
 *   voice signatures and the "thinking" detector
 */
export function useAudioPipeline(
  hasBridge: boolean,
  onLog: (level: string, message: string) => void,
  micDeviceId = "",
) {
  const [muted, setMuted] = useState(false);

  const inputContextRef = useRef<AudioContext | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputProcessorRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const capturePromiseRef = useRef<Promise<void> | null>(null);
  const captureGenerationRef = useRef(0);
  const outputContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  // Separate meters so the orb can tell WHO is talking: your mic drives the
  // radial-bar signature, Iris's playback drives the smooth wave.
  const inputLevelRef = useRef(0);
  const outputLevelRef = useRef(0);

  useEffect(() => {
    if (!hasBridge) return;
    const offAudio = window.iris.onAudioChunk((chunk) => playChunk(chunk));
    const offInterrupt = window.iris.onAudioInterrupt(() => flushPlayback());
    return () => {
      offAudio();
      offInterrupt();
    };
  }, [hasBridge]);

  useEffect(
    () => () => {
      captureGenerationRef.current += 1;
      void stopCapture();
      flushPlayback();
      outputAnalyserRef.current?.disconnect();
      outputAnalyserRef.current = null;
      const output = outputContextRef.current;
      outputContextRef.current = null;
      if (output) void output.close().catch(() => undefined);
    },
    [],
  );

  // Passive audio level meter (mic in / Gemini out) for the reactive HUD.
  useEffect(() => {
    let raf = 0;
    const buf = new Uint8Array(256);
    const rms = (analyser: AnalyserNode | null) => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    };
    const tick = () => {
      const input = Math.min(1, rms(inputAnalyserRef.current) * 2.6);
      const output = Math.min(1, rms(outputAnalyserRef.current) * 2.6);
      inputLevelRef.current += (input - inputLevelRef.current) * 0.4;
      outputLevelRef.current += (output - outputLevelRef.current) * 0.4;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // "exact" first so the chosen mic genuinely wins (soft "ideal" hints let the
  // browser keep whatever it prefers); explicit fallback to the system default
  // if that device is unplugged so the wake never fails.
  async function openMicStream(deviceId: string) {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...base, deviceId: { exact: deviceId } },
          video: false,
        });
      } catch {
        onLog("warn", "Selected microphone unavailable — using the system default.");
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }

  async function startCapture(deviceOverride?: string) {
    if (!hasBridge || inputContextRef.current) return;
    if (capturePromiseRef.current) return capturePromiseRef.current;
    const generation = ++captureGenerationRef.current;
    const operation = (async () => {
      const stream = await openMicStream(deviceOverride ?? micDeviceId);
      if (generation !== captureGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const send = (input: Float32Array) => {
        const pcm = downsampleTo16k(input, context.sampleRate);
        if (pcm.byteLength <= 0) return;
        const chunk = new ArrayBuffer(pcm.byteLength);
        new Uint8Array(chunk).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        window.iris.sendAudioChunk(chunk);
      };

      let processor: AudioWorkletNode | ScriptProcessorNode;
      try {
        await context.audioWorklet.addModule(
          `${import.meta.env.BASE_URL}audio/iris-pcm-capture-worklet.js`,
        );
        const worklet = new AudioWorkletNode(context, "iris-pcm-capture");
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => send(event.data);
        processor = worklet;
      } catch {
        const fallback = context.createScriptProcessor(1024, 1, 1);
        fallback.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          send(event.inputBuffer.getChannelData(0));
        };
        processor = fallback;
        onLog("warn", "AudioWorklet unavailable — using compatibility microphone processing.");
      }

      if (generation !== captureGenerationRef.current) {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => undefined);
        return;
      }

      // Passive meter tap for the reactive HUD (does not affect what is sent).
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      source.connect(processor);
      processor.connect(context.destination);

      inputContextRef.current = context;
      inputStreamRef.current = stream;
      inputSourceRef.current = source;
      inputProcessorRef.current = processor;
      inputAnalyserRef.current = analyser;
      onLog("info", "WebRTC echo cancellation enabled for microphone.");
    })();
    capturePromiseRef.current = operation;
    try {
      await operation;
    } finally {
      if (capturePromiseRef.current === operation) capturePromiseRef.current = null;
    }
  }

  async function stopCapture() {
    captureGenerationRef.current += 1;
    const pending = capturePromiseRef.current;
    if (pending) await pending.catch(() => undefined);
    if (inputProcessorRef.current instanceof AudioWorkletNode) {
      inputProcessorRef.current.port.onmessage = null;
    } else if (inputProcessorRef.current) {
      inputProcessorRef.current.onaudioprocess = null;
    }
    inputProcessorRef.current?.disconnect();
    inputSourceRef.current?.disconnect();
    inputAnalyserRef.current?.disconnect();
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    await inputContextRef.current?.close().catch(() => undefined);

    inputProcessorRef.current = null;
    inputSourceRef.current = null;
    inputStreamRef.current = null;
    inputContextRef.current = null;
    inputAnalyserRef.current = null;
    setMuted(false);
  }

  function flushPlayback() {
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    playbackSourcesRef.current = [];
    if (outputContextRef.current) {
      playbackTimeRef.current = outputContextRef.current.currentTime;
    }
  }

  async function playChunk(chunk: LiveAudioChunk) {
    const rate = parsePcmRate(chunk.mimeType);
    const bytes = base64ToBytes(chunk.data);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;

    const context = outputContextRef.current ?? new AudioContext();
    outputContextRef.current = context;
    if (context.state === "suspended") await context.resume();

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, sampleCount, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    let analyser = outputAnalyserRef.current;
    if (!analyser || analyser.context !== context) {
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(context.destination);
      outputAnalyserRef.current = analyser;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
    };

    const startAt = Math.max(context.currentTime + 0.03, playbackTimeRef.current || 0);
    source.start(startAt);
    playbackTimeRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.push(source);
  }

  function toggleMute() {
    const stream = inputStreamRef.current;
    setMuted((current) => {
      const next = !current;
      stream?.getAudioTracks().forEach((track) => (track.enabled = !next));
      return next;
    });
  }

  return { muted, toggleMute, inputLevelRef, outputLevelRef, startCapture, stopCapture, flushPlayback };
}
