from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
import time
import traceback
from typing import Any

import pyaudio
from google import genai
from google.genai import types

from hermes_client import HermesClient, HermesError
from hermes_process import HermesProcessManager
from protocol import emit, emit_log

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
# Best practice: send 20-40ms chunks. 512 samples @ 16kHz = 32ms for low-latency
# input and snappy barge-in / interruption handling.
CHUNK_SIZE = 512

DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview"
DEFAULT_MODE = "none"
DEFAULT_VOICE = "Zephyr"


def load_env_file() -> None:
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key or key in os.environ:
                continue

            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            os.environ[key] = value


load_env_file()

SYSTEM_INSTRUCTION = """
You are Iris, the realtime voice front-end for Ashutosh. Your brain and hands
are Hermes, an autonomous agent that can use the terminal, files, web search,
browsing, code, and automations. You are calm, futuristic, and extremely concise.

CORE RULE: Be decisive. Do NOT interrogate the user. When Ashutosh asks for
almost anything actionable (find a deal, research X, build Y, check Z, fix this,
book, summarize, look something up, automate something), immediately call
submit_hermes_task and pass his request through verbatim or lightly cleaned up.
Hermes is smart and will figure out the website, the source, the tools, and the
details on its own. It is Hermes's job to resolve ambiguity, not yours.

Do NOT ask "which website", "what budget", "what do you mean", or similar
clarifying questions unless the request is truly impossible to act on at all
(for example, it references something only Ashutosh can know and there is no
reasonable default). Prefer sensible defaults and let Hermes proceed.

When you delegate:
- Call submit_hermes_task with a clear task string.
- Do not wait for Hermes to finish; it runs in the background.
- After it returns a run_id, give a one-line acknowledgement like
  "On it, Hermes is handling that now." Then stop talking.
- Never claim a task is done until the app reports completion to you.

Only handle trivially conversational things (greetings, quick facts you already
know, status questions) directly without Hermes. Keep every spoken reply short.
"""


def build_tools() -> list[dict[str, Any]]:
    task_schema = {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": "The exact work Hermes should perform.",
            },
            "session_id": {
                "type": "string",
                "description": "Optional stable session id for this Hermes workstream.",
            },
            "urgency": {
                "type": "string",
                "description": "Optional urgency: low, normal, high.",
            },
        },
        "required": ["task"],
    }

    run_schema = {
        "type": "object",
        "properties": {
            "run_id": {
                "type": "string",
                "description": "Hermes run id returned by submit_hermes_task.",
            }
        },
        "required": ["run_id"],
    }

    approval_schema = {
        "type": "object",
        "properties": {
            "run_id": {"type": "string"},
            "choice": {
                "type": "string",
                "description": "Approval choice: once, session, always, or deny.",
            },
        },
        "required": ["run_id", "choice"],
    }

    return [
        {
            "function_declarations": [
                {
                    "name": "check_hermes_status",
                    "description": "Check whether the local Hermes API server is reachable.",
                    "parameters": {"type": "object", "properties": {}},
                },
                {
                    "name": "start_hermes",
                    "description": "Start Hermes gateway with the local API server if it is not reachable.",
                    "parameters": {"type": "object", "properties": {}},
                },
                {
                    "name": "submit_hermes_task",
                    "description": (
                        "Start a background Hermes run for coding, terminal, file, research, "
                        "or long-running agent work. Returns quickly with a run_id."
                    ),
                    "parameters": task_schema,
                },
                {
                    "name": "get_hermes_task_status",
                    "description": "Fetch the latest status for a Hermes run.",
                    "parameters": run_schema,
                },
                {
                    "name": "stop_hermes_task",
                    "description": "Ask Hermes to stop an active run.",
                    "parameters": run_schema,
                },
                {
                    "name": "approve_hermes_action",
                    "description": "Resolve a Hermes approval request for a run.",
                    "parameters": approval_schema,
                },
            ]
        }
    ]


def build_config(voice_name: str) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        media_resolution="MEDIA_RESOLUTION_MEDIUM",
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=104857,
            sliding_window=types.SlidingWindow(target_tokens=52428),
        ),
        # Session resumption lets us survive periodic WebSocket resets / GoAway
        # without losing context on long sessions.
        session_resumption=types.SessionResumptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        tools=build_tools(),
        system_instruction=SYSTEM_INSTRUCTION,
    )


class AudioLoop:
    def __init__(self, video_mode: str, model: str, voice_name: str):
        self.video_mode = video_mode
        self.model = model
        self.voice_name = voice_name

        self.audio_in_queue: asyncio.Queue[bytes] | None = None
        self.out_queue: asyncio.Queue[dict[str, Any]] | None = None
        self.session: Any = None
        self.audio_stream: Any = None
        self.shutdown_event = asyncio.Event()
        self.run_watchers: dict[str, asyncio.Task] = {}

        self.last_model_audio = 0.0
        self.duplex_mode = os.environ.get("VOICE_DUPLEX_MODE", "speaker").strip().lower()
        self.speaker_guard_seconds = float(os.environ.get("SPEAKER_ECHO_GUARD_SECONDS", "0.9"))
        self.session_handle: str | None = None

        # Transcription deltas stream in many small pieces; buffer them and emit
        # one clean line per speaker per turn instead of spamming fragments.
        self._user_buf = ""
        self._gemini_buf = ""

        hermes_key = os.environ.get("API_SERVER_KEY", "iris-local-dev")
        hermes_url = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8642")
        self.hermes = HermesClient(base_url=hermes_url, api_key=hermes_key)
        self.hermes_process = HermesProcessManager(self.hermes)

        self.client = genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=os.environ.get("GEMINI_API_KEY"),
        )

    def _get_frame(self, cap: Any) -> dict[str, Any] | None:
        import cv2
        import PIL.Image

        ret, frame = cap.read()
        if not ret:
            return None

        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = PIL.Image.fromarray(frame_rgb)
        img.thumbnail([1024, 1024])

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        return {
            "kind": "image",
            "mime_type": "image/jpeg",
            "data": image_io.read(),
        }

    async def get_frames(self) -> None:
        import cv2

        cap = await asyncio.to_thread(cv2.VideoCapture, 0)
        try:
            while not self.shutdown_event.is_set():
                frame = await asyncio.to_thread(self._get_frame, cap)
                if frame is None:
                    break
                await asyncio.sleep(1.0)
                if self.out_queue is not None:
                    await self.out_queue.put(frame)
        finally:
            cap.release()

    def _get_screen(self) -> dict[str, Any]:
        try:
            import mss
            import mss.tools
            import PIL.Image
        except ImportError as exc:
            raise ImportError("Please install mss and pillow for screen mode.") from exc

        with mss.mss() as sct:
            monitor = sct.monitors[0]
            shot = sct.grab(monitor)
            image_bytes = mss.tools.to_png(shot.rgb, shot.size)

        img = PIL.Image.open(io.BytesIO(image_bytes))
        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)
        return {
            "kind": "image",
            "mime_type": "image/jpeg",
            "data": image_io.read(),
        }

    async def get_screen(self) -> None:
        while not self.shutdown_event.is_set():
            frame = await asyncio.to_thread(self._get_screen)
            await asyncio.sleep(1.0)
            if self.out_queue is not None:
                await self.out_queue.put(frame)

    async def listen_audio(self) -> None:
        pya = pyaudio.PyAudio()
        mic_info = pya.get_default_input_device_info()
        self.audio_stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        emit("audio_state", state="listening", device=mic_info.get("name"))

        kwargs = {"exception_on_overflow": False}
        while not self.shutdown_event.is_set():
            data = await asyncio.to_thread(self.audio_stream.read, CHUNK_SIZE, **kwargs)
            if self.out_queue is not None:
                await self.out_queue.put(
                    {"kind": "audio", "data": data, "mime_type": "audio/pcm;rate=16000"}
                )

    async def send_realtime(self) -> None:
        while not self.shutdown_event.is_set():
            if self.out_queue is None:
                await asyncio.sleep(0.1)
                continue

            msg = await self.out_queue.get()
            if self.session is None:
                continue

            kind = msg.get("kind")
            blob = types.Blob(data=msg["data"], mime_type=msg["mime_type"])
            if kind == "audio":
                # Laptop-speaker mode: do not forward mic audio while Iris is
                # speaking, otherwise Gemini hears its own voice and self-interrupts.
                # Set VOICE_DUPLEX_MODE=headphones to allow full barge-in.
                if self.duplex_mode != "headphones" and self._speaker_echo_window_open():
                    continue
                await self.session.send_realtime_input(audio=blob)
            elif kind == "image":
                await self.session.send_realtime_input(video=blob)

    def _speaker_echo_window_open(self) -> bool:
        if self.audio_in_queue is not None and not self.audio_in_queue.empty():
            return True
        return (time.monotonic() - self.last_model_audio) < self.speaker_guard_seconds

    def _flush_playback(self) -> None:
        if self.audio_in_queue is None:
            return
        while not self.audio_in_queue.empty():
            try:
                self.audio_in_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def _flush_transcripts(self) -> None:
        if self._user_buf.strip():
            emit("transcript", speaker="you", text=self._user_buf.strip())
        if self._gemini_buf.strip():
            emit("transcript", speaker="gemini", text=self._gemini_buf.strip())
        self._user_buf = ""
        self._gemini_buf = ""

    def _handle_server_content(self, server_content: Any) -> bool:
        """Handle one Live API server_content event.

        Returns True when an interruption was received. This mirrors the official
        sample shape: read audio from server_content.model_turn.parts[].inline_data
        rather than relying on SDK convenience fields.
        """
        if server_content is None:
            return False

        if getattr(server_content, "interrupted", None):
            self._flush_playback()
            self._flush_transcripts()
            emit("audio_state", state="listening")
            return True

        user_tx = getattr(server_content, "input_transcription", None)
        if user_tx is not None and getattr(user_tx, "text", None):
            self._user_buf += user_tx.text

        output_tx = getattr(server_content, "output_transcription", None)
        if output_tx is not None and getattr(output_tx, "text", None):
            self._gemini_buf += output_tx.text

        model_turn = getattr(server_content, "model_turn", None)
        parts = getattr(model_turn, "parts", None) or []
        for part in parts:
            if text := getattr(part, "text", None):
                self._gemini_buf += text

            inline_data = getattr(part, "inline_data", None)
            if inline_data is None:
                continue

            mime_type = getattr(inline_data, "mime_type", "") or ""
            if not mime_type.startswith("audio/"):
                continue

            audio_data = getattr(inline_data, "data", None)
            if not audio_data:
                continue

            if self.audio_in_queue is not None:
                self.audio_in_queue.put_nowait(audio_data)
            self.last_model_audio = time.monotonic()
            emit("audio_state", state="speaking")

        return False

    async def receive_audio(self) -> None:
        while not self.shutdown_event.is_set():
            if self.session is None:
                await asyncio.sleep(0.1)
                continue

            turn = self.session.receive()
            async for response in turn:
                # Capture session-resumption handle so we can reconnect later.
                if update := getattr(response, "session_resumption_update", None):
                    if getattr(update, "resumable", None) and getattr(update, "new_handle", None):
                        self.session_handle = update.new_handle

                # Server is about to drop the connection.
                if go_away := getattr(response, "go_away", None):
                    emit_log(f"Gemini GoAway: reconnecting soon ({go_away}).", level="warning")

                if tool_call := getattr(response, "tool_call", None):
                    await self.handle_tool_call(tool_call)

                server_content = getattr(response, "server_content", None)
                if self._handle_server_content(server_content):
                    continue

                # Compatibility fallback for text-only events.
                if text := getattr(response, "text", None):
                    self._gemini_buf += text

            # Turn finished. Emit the coalesced transcript lines and let queued
            # audio keep playing to the end.
            self._flush_transcripts()
            emit("audio_state", state="listening")

    async def play_audio(self) -> None:
        pya = pyaudio.PyAudio()
        stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=RECEIVE_SAMPLE_RATE,
            output=True,
        )
        while not self.shutdown_event.is_set():
            if self.audio_in_queue is None:
                await asyncio.sleep(0.1)
                continue
            bytestream = await self.audio_in_queue.get()
            await asyncio.to_thread(stream.write, bytestream)
            self.last_model_audio = time.monotonic()

    async def command_loop(self) -> None:
        while not self.shutdown_event.is_set():
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                await asyncio.sleep(0.1)
                continue

            try:
                command = __import__("json").loads(line)
            except Exception:
                emit_log(f"Ignoring malformed command: {line.strip()}", level="warning")
                continue

            command_type = command.get("type")
            if command_type == "shutdown":
                self.shutdown_event.set()
                return
            if command_type == "text" and self.session is not None:
                await self.session.send_realtime_input(text=command.get("text", "."))
            if command_type == "submit_hermes_task":
                await self.submit_hermes_task(command.get("task", ""), command.get("session_id", "iris-voice"))

    async def handle_tool_call(self, tool_call: Any) -> None:
        function_responses = []
        for fc in getattr(tool_call, "function_calls", []):
            name = fc.name
            args = dict(fc.args or {})
            emit("tool_call", name=name, args=args)
            try:
                result = await self.execute_tool(name, args)
            except Exception as exc:
                result = {
                    "status": "error",
                    "error": str(exc),
                }
            function_responses.append(
                types.FunctionResponse(name=name, id=fc.id, response=result)
            )

        if function_responses and self.session is not None:
            await self.session.send_tool_response(function_responses=function_responses)

    async def execute_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "check_hermes_status":
            return self.hermes_process.status()
        if name == "start_hermes":
            return await asyncio.to_thread(self.hermes_process.ensure_running)
        if name == "submit_hermes_task":
            return await self.submit_hermes_task(
                args.get("task", ""),
                args.get("session_id") or "iris-voice",
                args.get("urgency") or "normal",
            )
        if name == "get_hermes_task_status":
            return await asyncio.to_thread(self.hermes.get_run, args["run_id"])
        if name == "stop_hermes_task":
            return await asyncio.to_thread(self.hermes.stop_run, args["run_id"])
        if name == "approve_hermes_action":
            return await asyncio.to_thread(self.hermes.approve_run, args["run_id"], args["choice"])
        return {"status": "error", "error": f"Unknown tool: {name}"}

    async def submit_hermes_task(
        self,
        task: str,
        session_id: str = "iris-voice",
        urgency: str = "normal",
    ) -> dict[str, Any]:
        if not task.strip():
            return {"status": "error", "error": "Task is required."}

        emit("hermes_task_update", status="starting", task=task)
        await asyncio.to_thread(self.hermes_process.ensure_running)

        instructions = (
            "You are being invoked from a realtime voice manager. Work autonomously, "
            "but keep final output concise because it may be spoken aloud."
        )
        run = await asyncio.to_thread(self.hermes.start_run, task, session_id, instructions)
        run_id = run.get("run_id") or run.get("id")
        emit("hermes_task_update", status="started", task=task, run_id=run_id, urgency=urgency)

        if run_id:
            watcher = asyncio.create_task(self.watch_hermes_run(run_id, task))
            self.run_watchers[run_id] = watcher

        return {
            "status": "started",
            "run_id": run_id,
            "message": "Hermes has started the task in the background.",
        }

    async def watch_hermes_run(self, run_id: str, task: str) -> None:
        terminal = {"completed", "failed", "cancelled", "canceled"}
        last_status = None

        while not self.shutdown_event.is_set():
            try:
                run = await asyncio.to_thread(self.hermes.get_run, run_id)
            except HermesError as exc:
                emit("hermes_task_update", status="error", run_id=run_id, error=str(exc), task=task)
                return

            status = str(run.get("status", "unknown"))
            if status != last_status:
                emit("hermes_task_update", status=status, run_id=run_id, task=task, run=run)
                last_status = status

            if status in terminal:
                output = run.get("output") or run.get("final_response") or ""
                emit("hermes_task_update", status=status, run_id=run_id, task=task, output=output)
                if self.session is not None and output:
                    await self.session.send_realtime_input(
                        text=(
                            f"Hermes finished run {run_id}. "
                            f"Summarize this briefly for the user: {output[:1500]}"
                        )
                    )
                return

            await asyncio.sleep(2.0)

    async def boot_hermes(self) -> None:
        """Start the Hermes gateway in the background as soon as the app wakes."""
        emit("hermes_status", status="starting")
        try:
            result = await asyncio.to_thread(self.hermes_process.ensure_running)
            emit("hermes_status", status="ready", detail=result)
            emit_log("Hermes gateway is up and linked.")
        except HermesError as exc:
            emit("hermes_status", status="error", error=str(exc))
            emit_log(f"Could not start Hermes automatically: {exc}", level="warning")

    async def run(self) -> None:
        if not os.environ.get("GEMINI_API_KEY"):
            emit("fatal", message="GEMINI_API_KEY is not set.")
            return

        config = build_config(self.voice_name)
        emit("sidecar_status", status={"running": True, "model": self.model, "mode": self.video_mode})

        try:
            async with (
                self.client.aio.live.connect(model=self.model, config=config) as session,
                asyncio.TaskGroup() as tg,
            ):
                self.session = session
                self.audio_in_queue = asyncio.Queue()
                self.out_queue = asyncio.Queue(maxsize=5)

                emit("gemini_status", status="connected", model=self.model)

                tg.create_task(self.boot_hermes())
                tg.create_task(self.command_loop())
                tg.create_task(self.send_realtime())
                tg.create_task(self.listen_audio())
                tg.create_task(self.receive_audio())
                tg.create_task(self.play_audio())

                if self.video_mode == "camera":
                    tg.create_task(self.get_frames())
                elif self.video_mode == "screen":
                    tg.create_task(self.get_screen())

                await self.shutdown_event.wait()
                raise asyncio.CancelledError("Shutdown requested")

        except asyncio.CancelledError:
            pass
        except ExceptionGroup as exc_group:
            traceback.print_exception(exc_group)
            emit("fatal", message="Sidecar crashed.", error=str(exc_group))
        finally:
            if self.audio_stream is not None:
                self.audio_stream.close()
            self.hermes_process.stop_if_owned()
            emit("sidecar_status", status={"running": False})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["camera", "screen", "none"], default=DEFAULT_MODE)
    parser.add_argument("--model", default=os.environ.get("GEMINI_LIVE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--voice", default=os.environ.get("GEMINI_LIVE_VOICE", DEFAULT_VOICE))
    parser.add_argument("--ui-stdio", action="store_true", help="Emit JSON events for Electron.")
    args = parser.parse_args()

    loop = AudioLoop(video_mode=args.mode, model=args.model, voice_name=args.voice)
    asyncio.run(loop.run())


if __name__ == "__main__":
    main()
