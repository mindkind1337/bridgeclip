#!/usr/bin/env python3
"""
BridgeClip Live Runner

Long-running bridge for live streams. The first stdin line is a JSON spec:

- ``{"mode": "probe", "channels": [...]}`` reports which channels are live now
  and exits.
- ``{"mode": "record", ...}`` records one channel's live stream in chunks and
  clips each chunk with the normal pipeline until the stream ends. Creating a
  file named ``stop`` in the session's work folder finishes the current chunk
  and exits. (A thread blocked reading stdin can stall the whole process on
  Windows, so stdin carries only the spec.)

JSON lines on stdout use the same protocol stream as bridge_runner.
"""

import asyncio
import json
import logging
import os
import queue
import re
import sys
import threading
import time
import uuid

import bridge_runner as bridge

logger = logging.getLogger("live_runner")

MAX_PROBE_CHANNELS = 50
MAX_PENDING_CHUNKS = 2
LIVE_ERRORS = {
    "unsupported_channel": ("This channel link is not supported.",
                            "Use a Twitch (twitch.tv/name), Kick (kick.com/name) or YouTube (youtube.com/@handle) channel."),
    "no_live_format": ("This live stream has no recordable format.",
                       "Subscriber-only, members-only and region-locked streams are not supported."),
    "encrypted_stream": ("This live stream is protected and cannot be recorded.", None),
    "unsupported_stream": ("This live stream uses a format BridgeClip cannot record yet.", None),
    "resolve_failed": ("The live stream could not be opened.",
                       "Check that the stream plays while signed out, then retry."),
    "network": ("The live stream stopped responding for several minutes.",
                "Check your connection. BridgeClip tries again automatically if the channel is still live."),
}


def live_error(reason: str) -> dict:
    message, hint = LIVE_ERRORS.get(reason, ("Live recording failed.", "Check your connection and retry."))
    return {"type": "error", "message": message, **({"hint": hint} if hint else {}), "code": f"live.{reason}"}


def validate_spec(spec: object) -> dict:
    """Reject malformed live requests before loading the engine."""
    if not isinstance(spec, dict) or spec.get("mode") not in ("probe", "record"):
        raise ValueError("Invalid live spec")
    if type(spec.get("contract_version")) is not int or spec["contract_version"] != 2:
        raise ValueError("Unsupported clipping engine contract version")
    if spec["mode"] == "probe":
        channels = spec.get("channels")
        if (not isinstance(channels, list) or not 1 <= len(channels) <= MAX_PROBE_CHANNELS
                or any(not isinstance(url, str) or not url or len(url) > 512 for url in channels)):
            raise ValueError("Invalid channel list")
        return spec
    session = spec.get("session_id")
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session):
        raise ValueError("A valid session_id is required")
    parent = spec.get("parent_pid")
    if parent is not None and (type(parent) is not int or parent <= 0):
        raise ValueError("Invalid parent_pid")
    for field, low, high in (("chunk_seconds", 60, 3600), ("overlap_seconds", 0, 300), ("max_clips_per_chunk", 1, 10)):
        if type(spec.get(field)) is not int or not low <= spec[field] <= high:
            raise ValueError(f"Invalid {field}")
    if "chat_priority" in spec and not isinstance(spec["chat_priority"], bool):
        raise ValueError("Invalid chat_priority")
    if spec["overlap_seconds"] * 2 >= spec["chunk_seconds"]:
        raise ValueError("Overlap must be under half the chunk length")
    clip = spec.get("clip")
    if not isinstance(clip, dict) or {"job_id", "video_url", "max_clips", "auto_clip_count",
                                      "start_time_seconds", "end_time_seconds"} & clip.keys():
        raise ValueError("Invalid clip settings")
    # Clip settings share the normal job's rules; the channel stands in as the source.
    bridge.validate_config({**clip, "contract_version": 2, "job_id": session, "video_url": spec.get("channel_url")})
    return spec


def probe(spec: dict) -> bool:
    from clip_engine.services.live_capture import LiveCaptureError, live_channel, resolve_live_stream

    for url in spec["channels"]:
        try:
            stream = resolve_live_stream(live_channel(url))
            bridge.emit({"type": "probe", "url": url, "live": stream is not None,
                         **({"title": stream.title, "channel": stream.channel} if stream else {})})
        except LiveCaptureError as error:
            bridge.emit({"type": "probe", "url": url, "live": False, "error": error.reason})
    return True


STOP_FILE = "stop"
PROGRESS_INTERVAL_SECONDS = 5.0


def process_alive(pid: int) -> bool:
    """Whether a process with this id still runs."""
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def watch_stop_file(path: str, stop: threading.Event, interval: float = 1.0, parent_pid: int | None = None,
                    on_orphaned=lambda: os._exit(1)) -> None:
    """Stop gracefully once Electron creates the stop file; quit at once if Electron is gone.

    Without the app nobody receives the clips, and a restarted app starts its
    own recording: an orphaned engine would record and spend twice.
    """
    while not stop.wait(interval):
        if os.path.exists(path):
            stop.set()
        elif parent_pid and not process_alive(parent_pid):
            logger.error("BridgeClip closed; stopping the live engine")
            on_orphaned()
            return


async def record(spec: dict) -> bool:
    from clip_engine.config import get_caption_preset, get_settings
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
    from clip_engine.services.live_capture import HlsCapture, LiveCaptureError, live_channel

    settings = get_settings()
    if not settings.openrouter_api_key:
        bridge.emit({"type": "error", "message": "Missing required API keys: OPENROUTER_API_KEY"})
        return False
    try:
        channel = live_channel(spec["channel_url"])
    except LiveCaptureError as error:
        bridge.emit(live_error(error.reason))
        return False

    clip = spec["clip"]
    caption_style = bridge.caption_style_for(clip, get_caption_preset)
    work_root = os.environ.get("BRIDGECLIP_WORK_ROOT") or os.path.abspath("work")
    work_dir = os.path.join(work_root, f"live-{spec['session_id']}")
    os.makedirs(work_dir, mode=0o700, exist_ok=True)

    chunks: "queue.Queue" = queue.Queue()
    stop = threading.Event()
    chat = start_chat(channel)
    threading.Thread(target=watch_stop_file, args=(os.path.join(work_dir, STOP_FILE), stop, spec.get("_stop_poll", 1.0),
                                                    spec.get("parent_pid")), name="live-stop", daemon=True).start()
    last_progress = [0.0]

    def on_progress(part: int, recorded: float, target: float, gaps: int, ads: int) -> None:
        now = time.monotonic()
        if now - last_progress[0] < PROGRESS_INTERVAL_SECONDS:
            return
        last_progress[0] = now
        capture = capture_holder.get("capture")
        network = capture.network() if capture is not None else None
        bridge.emit({"type": "progress", "part": part, "recorded_s": round(recorded, 1), "part_s": target,
                     "gaps": gaps, "ads": ads, **({"network": network} if network else {})})
    outcome: dict = {}
    capture_holder: dict = {}

    def capture_main() -> None:
        capture = capture_holder["capture"] = HlsCapture(
            channel, work_dir, chunks.put,
            chunk_seconds=spec["chunk_seconds"], overlap_seconds=spec["overlap_seconds"],
            stop_event=stop, on_status=lambda status: bridge.emit({
                "type": "status", "status": status,
                **({"stream_started_at": started} if (started := getattr(getattr(capture, "stream", None), "started_at", None)) else {}),
            }),
            on_progress=on_progress,
            **spec.get("_capture_options", {}),
        )
        try:
            outcome["reason"] = capture.run()
        except LiveCaptureError as error:
            outcome["error"] = error.reason
        except Exception as error:
            logger.error("Live capture failed (%s)", type(error).__name__)
            outcome["error"] = "capture_failed"
        finally:
            outcome["gaps"] = capture.gaps
            chunks.put(None)

    bridge.emit({"type": "status", "status": "resolving"})
    thread = threading.Thread(target=capture_main, name="live-capture", daemon=True)
    threading.Thread(target=find_replay, args=(channel, capture_holder, stop), name="live-replay", daemon=True).start()
    thread.start()
    pipeline = AIClippingPipeline(progress_callback=chunk_progress_reporter())
    loop = asyncio.get_running_loop()
    finished = False
    while not finished:
        item = await loop.run_in_executor(None, chunks.get)
        pending = [item]
        while True:
            try:
                pending.append(chunks.get_nowait())
            except queue.Empty:
                break
        if None in pending:
            finished = True
            pending = [chunk for chunk in pending if chunk is not None]
        # Processing fell behind the stream: keep the newest chunks only.
        while len(pending) > MAX_PENDING_CHUNKS:
            dropped = pending.pop(0)
            _remove(dropped.path)
            bridge.emit({"type": "chunk_failed", "part": dropped.part, "message": "Skipped: clipping fell behind the live stream."})
        for chunk in pending:
            await process_chunk(chunk, clip, caption_style, spec, pipeline, ClippingJobRequest, JobStatus, chat)
    thread.join()
    if chat:
        chat.stop.set()
    _remove_tree(work_dir)
    if outcome.get("error"):
        bridge.emit(live_error(outcome["error"]))
        return False
    bridge.emit({"type": "stream_ended", "reason": outcome.get("reason", "ended"), "gaps": outcome.get("gaps", 0)})
    return True


# Part being clipped, for the pipeline's progress callback.
_clipping_part: dict = {"part": None, "step": None}


def chunk_progress_reporter():
    """Report each new pipeline step of the part being clipped (not every percent)."""
    def report(progress) -> None:
        part, step = _clipping_part["part"], getattr(progress, "current_step", None)
        if part is None or not isinstance(step, str) or step == _clipping_part["step"]:
            return
        _clipping_part["step"] = step
        status = progress.status.value if hasattr(progress.status, "value") else str(progress.status)
        bridge.emit({"type": "chunk_progress", "part": part, "status": status, "step": step[:160],
                     "percent": progress.progress_percent, "clips_done": progress.clips_completed,
                     "clips_total": progress.total_clips})
    return report


REPLAY_ATTEMPTS = (60, 300, 900, 1800)


def find_replay(channel, capture_holder: dict, stop: threading.Event) -> None:
    """Report the broadcast's replay page once the platform has one (Twitch lists it after a few minutes)."""
    from clip_engine.services.live_capture import resolve_replay
    waited = 0
    for delay in REPLAY_ATTEMPTS:
        if stop.wait(delay - waited):
            return
        waited = delay
        stream = getattr(capture_holder.get("capture"), "stream", None)
        if stream is None:
            continue
        try:
            url = resolve_replay(channel, stream)
        except Exception as error:
            logger.warning("Replay lookup failed (%s)", type(error).__name__)
            continue
        if url:
            bridge.emit({"type": "replay", "url": url})
            return


def start_chat(channel):
    """Record the channel's chat alongside the stream (Twitch and Kick), or None."""
    if channel.platform not in ("twitch", "kick"):
        return None
    try:
        from clip_engine.services.live_chat import ChatRecorder
        name = channel.url.rstrip("/").rsplit("/", 1)[-1]
        return ChatRecorder(channel.platform, name, threading.Event(),
                            on_state=lambda state: bridge.emit({"type": "chat", "state": state})).start()
    except Exception as error:
        logger.warning("Live chat unavailable (%s)", type(error).__name__)
        return None


BOUNDARY_MARGIN_SECONDS = 3


def part_context(chunk, overlap_seconds: int) -> str:
    """Tell the planner this is one part of a live: moments cut by the part's end are seen whole in the next part."""
    lead_in = getattr(chunk, "lead_in_seconds", 0) or 0
    lines = [f"This video is part {chunk.part} of a live stream being recorded in parts."]
    if lead_in:
        lines.append(f"Its first {lead_in:.0f} seconds repeat the end of the previous part, so moments there were "
                     "already judged; prefer moments that run past them.")
    if not getattr(chunk, "final", False):
        lines.append(f"The next part will repeat the last {overlap_seconds} seconds of this one and continue the stream. "
                     "A moment still going on at the very end of this video is cut here and will be seen whole in the next part: "
                     f"do not pick a clip that runs into the last {BOUNDARY_MARGIN_SECONDS} seconds.")
    return " ".join(lines)


def priority_moment(messages, enabled: bool):
    """With chat priority on: the chunk time of the chat's biggest laugh (laughs lag the moment by a few seconds)."""
    if not enabled or not messages:
        return None
    from clip_engine.services.live_chat import laugh_peak
    peak = laugh_peak(messages)
    return None if peak is None else max(0.0, peak - 3)


def chat_for_chunk(chat, chunk) -> tuple:
    """(messages on the chunk's timeline, planner notes, stats); empty without chat or timing."""
    if chat is None or not getattr(chunk, "timeline", ()):
        return [], None, None
    from clip_engine.services.live_chat import place_on_timeline, summarize
    start = min(entry[1] for entry in chunk.timeline)
    end = max(entry[1] + entry[2] for entry in chunk.timeline)
    placed = place_on_timeline(chat.log.between(start, end), chunk.timeline)
    notes, stats = summarize(placed, chunk.duration_seconds)
    return placed, notes or None, stats


async def process_chunk(chunk, clip, caption_style, spec, pipeline, ClippingJobRequest, JobStatus, chat=None) -> None:
    job_id = str(uuid.uuid4())
    from clip_engine.services.live_capture import compress_timeline
    placement = {"job_id": job_id, "part": chunk.part, "stream_offset_s": chunk.stream_offset_seconds,
                 "duration_s": chunk.duration_seconds, "lead_in_s": chunk.lead_in_seconds,
                 "timeline": compress_timeline(getattr(chunk, "timeline", ())), "final": bool(getattr(chunk, "final", False))}
    bridge.emit({"type": "chunk_started", **placement})
    _clipping_part.update(part=chunk.part, step=None)
    chat_messages, chat_notes, chat_stats = chat_for_chunk(chat, chunk)
    priority = priority_moment(chat_messages, spec.get("chat_priority") is True)
    context = part_context(chunk, spec["overlap_seconds"])
    if priority is not None:
        context += (f" PRIORITY: the chat laughed the most at about {priority:.0f} s. Return one clip that includes"
                    " that moment and the setup that caused the laughter.")
        bridge.emit({"type": "chat_priority", "part": chunk.part, "at_s": priority})
    if chat is not None:
        bridge.emit({"type": "chat_summary", "part": chunk.part,
                     **({key: chat_stats[key] for key in ("messages", "peak_s", "peak_count", "peak_reaction", "laughs")
                         if key in chat_stats} if chat_stats else {"messages": 0, "timing": False})})
    try:
        request = ClippingJobRequest(
            video_url=chunk.path,
            job_id=job_id,
            max_clips=spec["max_clips_per_chunk"],
            auto_clip_count=False,
            duration_ranges=clip.get("duration_ranges"),
            aspect_ratio=clip.get("aspect_ratio", "9:16"),
            layout_style=clip.get("layout_style") or "auto",
            pacing=clip.get("pacing") or "tight",
            video_speed=clip.get("video_speed", 1.0),
            include_captions=clip.get("include_captions", True),
            caption_style=caption_style,
            banner_platform=clip.get("banner_platform"),
            banner_channel_url=clip.get("banner_channel_url"),
            keyterms=clip.get("keyterms") or None,
            audience_notes=chat_notes,
            context_notes=context,
            priority_moment_seconds=priority,
        )
        started = time.monotonic()
        result = await pipeline.process_video(request)
        if result.status == JobStatus.COMPLETED and result.output:
            if chat_stats and clip.get("output_dir"):
                save_part_chat(os.path.join(clip["output_dir"], job_id), chat_messages, chat_stats)
            bridge.emit({"type": "chunk_done", **placement, "clips": len(result.output.clips),
                         "processing_time_seconds": time.monotonic() - started})
        else:
            bridge.emit({"type": "chunk_failed", **placement, **bridge.failure_payload(result)})
    except Exception as error:
        logger.error("Live chunk failed (%s)", type(error).__name__)
        bridge.emit({"type": "chunk_failed", **placement, **bridge.describe_failure(error)})
    finally:
        _remove(chunk.path)


async def run(spec: dict) -> bool:
    spec = validate_spec(spec)
    if spec["mode"] == "record":
        bridge.configure_environment({**spec["clip"], "output_dir": spec["clip"].get("output_dir")})
    from network_guard import install as install_network_guard
    install_network_guard()
    from clip_engine.logging_safety import install_safe_logging
    install_safe_logging()
    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
    if spec["contract_version"] != BRIDGE_CONTRACT_VERSION:
        bridge.emit({"type": "error", "message": "The bundled clipping engine is incompatible with this BridgeClip version."})
        return False
    if spec["mode"] == "probe":
        return probe(spec)
    return await record(spec)


def save_part_chat(run_dir: str, messages, stats) -> None:
    try:
        if os.path.isdir(run_dir):
            from clip_engine.services.live_chat import save_chat
            save_chat(os.path.join(run_dir, "chat.json"), messages, stats)
    except OSError:
        logger.warning("Could not save the part's chat")


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _remove_tree(path: str) -> None:
    import shutil
    shutil.rmtree(path, ignore_errors=True)


def main() -> int:
    try:
        raw = sys.stdin.readline(65537)
        if len(raw) > 65536:
            raise ValueError("Spec too large")
        spec = validate_spec(json.loads(raw))
    except (ValueError, TypeError):
        bridge.emit({"type": "error", "message": "Invalid live configuration."})
        return 1
    try:
        return 0 if asyncio.run(run(spec)) else 1
    except KeyboardInterrupt:
        bridge.emit({"type": "error", "message": "Live recording cancelled"})
        return 130
    except Exception as error:
        logger.error("Live runner failed (%s)", type(error).__name__)
        bridge.emit({"type": "error", "message": "The live engine failed. Check your setup and retry."})
        return 1


if __name__ == "__main__":
    bridge.reserve_stdout_for_protocol()
    sys.exit(main())
