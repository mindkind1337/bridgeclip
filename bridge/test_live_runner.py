import asyncio
import io
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from contextlib import redirect_stdout
from dataclasses import dataclass
from unittest.mock import patch

import live_runner as live


class FakeCaptureError(Exception):
    def __init__(self, message, reason="live_failed"):
        super().__init__(message)
        self.reason = reason


@dataclass
class FakeChunk:
    part: int
    path: str
    stream_offset_seconds: float
    duration_seconds: float
    lead_in_seconds: float


def fake_channel(url):
    if "twitch.tv/" not in url:
        raise FakeCaptureError("bad", "unsupported_channel")
    return types.SimpleNamespace(platform="twitch", url=url)


class LiveRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.requests = []
        self.fail_parts = set()
        self.capture_done = threading.Event()
        self.settings_env = {}

    def spec(self, **overrides):
        return {
            "contract_version": 2, "mode": "record", "session_id": "s-1",
            "channel_url": "https://www.twitch.tv/streamer", "chunk_seconds": 600,
            "overlap_seconds": 90, "max_clips_per_chunk": 2,
            "clip": {"layout_vision_enabled": False, "clipping_mode": "economy",
                     "aspect_ratio": "9:16", "output_dir": os.path.abspath(self.tmp.name)},
            **overrides,
        }

    def modules(self, chunks, reason="ended", error=None, key="k"):
        test = self
        tmp = self.tmp.name

        class Capture:
            def __init__(self, channel, work_dir, on_chunk, **kwargs):
                self.on_chunk, self.gaps = on_chunk, 1
                self.kwargs = kwargs
                test.capture_kwargs = kwargs

            def run(self):
                self.kwargs["on_status"]("recording")
                for part in range(1, chunks + 1):
                    path = os.path.join(tmp, f"part{part}.mp4")
                    open(path, "wb").close()
                    self.on_chunk(FakeChunk(part, path, (part - 1) * 510.0, 600.0, 0 if part == 1 else 90.0))
                test.capture_done.set()
                if error:
                    raise FakeCaptureError("x", error)
                return reason

        class Pipeline:
            def __init__(self, **kwargs):
                pass

            async def process_video(self, request):
                # Hold the first chunk until capture has queued everything, so
                # backlog handling sees a deterministic queue.
                await asyncio.get_running_loop().run_in_executor(None, test.capture_done.wait)
                test.requests.append(request)
                part = len(test.requests)
                if part in test.fail_parts:
                    return types.SimpleNamespace(status="failed", output=None, error="No clip-worthy moments found")
                return types.SimpleNamespace(status="completed", output=types.SimpleNamespace(clips=[1, 2]))

        def get_settings():
            test.settings_env = {name: os.environ.get(name) for name in ("PLANNER_MODEL", "LOCAL_OUTPUT_DIR")}
            return types.SimpleNamespace(openrouter_api_key=key)

        return {
            "clip_engine.config": types.SimpleNamespace(
                get_settings=get_settings,
                get_caption_preset=lambda name: None),
            "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2),
            "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None),
            "clip_engine.services.ai_clipping_pipeline": types.SimpleNamespace(
                AIClippingPipeline=Pipeline, ClippingJobRequest=lambda **kwargs: kwargs,
                JobStatus=types.SimpleNamespace(COMPLETED="completed")),
            "clip_engine.services.live_capture": types.SimpleNamespace(
                HlsCapture=Capture, LiveCaptureError=FakeCaptureError, live_channel=fake_channel,
                resolve_live_stream=lambda channel: (
                    types.SimpleNamespace(title="Big game", channel="Streamer") if "live" in channel.url else None)),
        }

    def run_spec(self, spec, modules):
        output = io.StringIO()
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"BRIDGECLIP_WORK_ROOT": self.tmp.name}), \
                redirect_stdout(output):
            ok = asyncio.run(live.run(spec))
        return ok, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_each_chunk_is_clipped_as_a_local_job(self):
        ok, messages = self.run_spec(self.spec(), self.modules(chunks=2))
        self.assertTrue(ok)
        types_seen = [m["type"] for m in messages]
        self.assertEqual(types_seen, ["status", "status", "chunk_started", "chunk_done", "chunk_started", "chunk_done", "stream_ended"])
        started = [m for m in messages if m["type"] == "chunk_started"]
        self.assertEqual([m["stream_offset_s"] for m in started], [0.0, 510.0])
        self.assertEqual(started[1]["lead_in_s"], 90.0)
        self.assertNotEqual(started[0]["job_id"], started[1]["job_id"])
        request = self.requests[0]
        self.assertEqual((request["max_clips"], request["auto_clip_count"]), (2, False))
        self.assertEqual(request["job_id"], started[0]["job_id"])
        self.assertTrue(request["video_url"].endswith("part1.mp4"))
        self.assertFalse(os.path.exists(request["video_url"]), "processed chunks are deleted")
        self.assertEqual(messages[-1], {"type": "stream_ended", "reason": "ended", "gaps": 1})
        self.assertEqual((self.capture_kwargs["chunk_seconds"], self.capture_kwargs["overlap_seconds"]), (600, 90))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "live-s-1")))

    def test_economy_mode_is_configured_before_the_engine_loads(self):
        self.run_spec(self.spec(), self.modules(chunks=0))
        self.assertEqual(self.settings_env, {"PLANNER_MODEL": "z-ai/glm-5.3-flash",
                                             "LOCAL_OUTPUT_DIR": os.path.abspath(self.tmp.name)})

    def test_a_failed_chunk_does_not_stop_the_session(self):
        self.fail_parts = {1}
        ok, messages = self.run_spec(self.spec(), self.modules(chunks=2))
        self.assertTrue(ok)
        failed = [m for m in messages if m["type"] == "chunk_failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["message"], "BridgeClip couldn't find any clips in this video.")
        self.assertEqual([m["type"] for m in messages].count("chunk_done"), 1)

    def test_backlog_keeps_only_the_newest_chunks(self):
        ok, messages = self.run_spec(self.spec(), self.modules(chunks=4))
        self.assertTrue(ok)
        skipped = [m for m in messages if m["type"] == "chunk_failed"]
        # Part 1 was already being clipped; of the three waiting, only the newest two are kept.
        self.assertEqual([m["part"] for m in skipped], [2])
        self.assertEqual([m["part"] for m in messages if m["type"] == "chunk_done"], [1, 3, 4])

    def test_capture_errors_are_reported_after_pending_chunks(self):
        ok, messages = self.run_spec(self.spec(), self.modules(chunks=1, error="no_live_format"))
        self.assertFalse(ok)
        self.assertEqual(messages[-2]["type"], "chunk_done")
        self.assertEqual(messages[-1]["code"], "live.no_live_format")

    def test_missing_key_stops_before_recording(self):
        ok, messages = self.run_spec(self.spec(), self.modules(chunks=1, key=""))
        self.assertFalse(ok)
        self.assertEqual(messages, [{"type": "error", "message": "Missing required API keys: OPENROUTER_API_KEY"}])

    def test_probe_reports_each_channel(self):
        spec = {"contract_version": 2, "mode": "probe",
                "channels": ["https://www.twitch.tv/live_one", "https://www.twitch.tv/off", "https://example.com/x"]}
        ok, messages = self.run_spec(spec, self.modules(chunks=0))
        self.assertTrue(ok)
        self.assertEqual(messages, [
            {"type": "probe", "url": "https://www.twitch.tv/live_one", "live": True, "title": "Big game", "channel": "Streamer"},
            {"type": "probe", "url": "https://www.twitch.tv/off", "live": False},
            {"type": "probe", "url": "https://example.com/x", "live": False, "error": "unsupported_channel"},
        ])

    def test_invalid_specs_are_rejected(self):
        bad = [
            None, {"mode": "other"}, self.spec(contract_version=1), self.spec(session_id="../x"),
            self.spec(chunk_seconds=30), self.spec(overlap_seconds=400), self.spec(chunk_seconds=120, overlap_seconds=60),
            self.spec(max_clips_per_chunk=0), self.spec(clip={"layout_vision_enabled": False, "max_clips": 3}),
            self.spec(clip={"layout_vision_enabled": False, "aspect_ratio": "1:1"}),
            self.spec(channel_url="file:///etc/passwd"),
            {"contract_version": 2, "mode": "probe", "channels": []},
            {"contract_version": 2, "mode": "probe", "channels": ["x"] * 51},
        ]
        for spec in bad:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                live.validate_spec(spec)

    def test_stop_line_sets_the_stop_event(self):
        stop = threading.Event()
        with patch.object(sys, "stdin", io.StringIO("noise\nstop\n")):
            live.watch_stdin(stop)
        self.assertTrue(stop.is_set())

    def test_main_rejects_malformed_input(self):
        output = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO("[]\n")), redirect_stdout(output):
            self.assertEqual(live.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["message"], "Invalid live configuration.")


if __name__ == "__main__":
    unittest.main()
