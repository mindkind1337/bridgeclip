"""Live stream capture: resolve a channel's live HLS playlist and record it in chunks.

yt-dlp only resolves the playlist. Its native HLS downloader does not record live
streams and hands them to FFmpeg, which the network policy forbids, so segments
are fetched here through pinned public connections and appended to local chunks:
MPEG-TS segments as they are, fragmented MP4 segments after their init segment.
Each finished chunk is remuxed to MP4 with a local-only FFmpeg command.
"""

import logging
import os
import re
import shutil
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional
from urllib.parse import urljoin, urlsplit

from clip_engine.services.media_process import run_media

logger = logging.getLogger(__name__)

MAX_PLAYLIST_BYTES = 2 * 1024 * 1024
MAX_SEGMENT_BYTES = 64 * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024 * 1024 * 1024
MAX_SESSION_SECONDS = 12 * 60 * 60
MIN_FINAL_CHUNK_SECONDS = 30.0
MAX_LIVE_HEIGHT = 1080
REQUEST_TIMEOUT_SECONDS = 20
SEGMENT_ATTEMPTS = 3
REMUX_TIMEOUT_SECONDS = 10 * 60
MAX_WAITING_SEGMENTS = 60
MAX_INIT_BYTES = 1024 * 1024
MAX_INIT_SEGMENTS = 16

TWITCH_LOGIN = re.compile(r"[A-Za-z0-9_]{1,25}")
YOUTUBE_HANDLE = re.compile(r"@[A-Za-z0-9._-]{3,30}")
YOUTUBE_CHANNEL_ID = re.compile(r"UC[A-Za-z0-9_-]{22}")
TWITCH_HOSTS = {"twitch.tv", "www.twitch.tv", "m.twitch.tv"}
KICK_HOSTS = {"kick.com", "www.kick.com"}
KICK_SLUG = re.compile(r"[A-Za-z0-9_-]{2,40}")
KICK_RESERVED = {"video", "videos", "categories", "category", "search", "auth", "following", "browse", "clips",
                 "settings", "dashboard", "terms-of-service", "privacy-policy", "community-guidelines"}
LIVE_EXTRACTORS = {"twitch": ["twitch:stream"], "youtube": ["youtube", "youtube:tab"], "kick": ["kick:live"]}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
NOT_LIVE_MARKERS = ("not currently live", "is offline", "not live", "will begin", "premieres in",
                    "this live event will begin", "does not exist")


class LiveCaptureError(Exception):
    """A live stream could not be resolved or recorded."""

    def __init__(self, message: str, reason: str = "live_failed"):
        super().__init__(message)
        self.reason = reason


class PlaylistExpired(Exception):
    """The playlist URL stopped working; resolve the stream again."""


@dataclass(frozen=True)
class LiveChannel:
    platform: str
    url: str


@dataclass(frozen=True)
class LiveStream:
    playlist_url: str
    title: str
    channel: str
    platform: str
    height: int
    # YouTube serves live audio as its own playlist, numbered like the video's.
    audio_playlist_url: Optional[str] = None


@dataclass(frozen=True)
class Segment:
    sequence: int
    uri: str
    duration: float
    title: str = ""
    discontinuity: bool = False
    # Fragmented MP4: the init segment (EXT-X-MAP) this media segment decodes with.
    init_uri: Optional[str] = None


@dataclass(frozen=True)
class Recorded:
    """A downloaded segment of the chunk being built, with its stream offset."""
    path: str
    audio_path: Optional[str]
    duration: float
    offset: float
    init_path: Optional[str] = None
    audio_init_path: Optional[str] = None


@dataclass
class MediaPlaylist:
    target_duration: float
    media_sequence: int
    segments: list[Segment] = field(default_factory=list)
    ended: bool = False


@dataclass(frozen=True)
class Chunk:
    part: int
    path: str
    stream_offset_seconds: float
    duration_seconds: float
    lead_in_seconds: float


def live_channel(url: str) -> LiveChannel:
    """Accept only a Twitch, Kick or YouTube channel page, in canonical form."""
    if not isinstance(url, str) or len(url) > 512:
        raise LiveCaptureError("Unsupported live channel", "unsupported_channel")
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    try:
        port_ok = parts.port in (None, 443)
    except ValueError:
        port_ok = False
    path = parts.path.rstrip("/")
    if parts.scheme != "https" or parts.username or parts.password or not port_ok:
        raise LiveCaptureError("Unsupported live channel", "unsupported_channel")
    if host in TWITCH_HOSTS:
        login = path[1:]
        if TWITCH_LOGIN.fullmatch(login) and login.lower() not in {"videos", "directory", "settings", "p"}:
            return LiveChannel("twitch", f"https://www.twitch.tv/{login.lower()}")
    elif host in KICK_HOSTS:
        slug = path[1:]
        if KICK_SLUG.fullmatch(slug) and slug.lower() not in KICK_RESERVED:
            return LiveChannel("kick", f"https://kick.com/{slug.lower()}")
    elif host in YOUTUBE_HOSTS:
        segments = path[1:].split("/")
        if segments and segments[-1] == "live":
            segments = segments[:-1]
        if len(segments) == 1 and YOUTUBE_HANDLE.fullmatch(segments[0]):
            return LiveChannel("youtube", f"https://www.youtube.com/{segments[0]}/live")
        if len(segments) == 2 and segments[0] == "channel" and YOUTUBE_CHANNEL_ID.fullmatch(segments[1]):
            return LiveChannel("youtube", f"https://www.youtube.com/channel/{segments[1]}/live")
    raise LiveCaptureError("Unsupported live channel", "unsupported_channel")


def _has(fmt: dict, kind: str) -> bool:
    return fmt.get(kind) not in ("none", None)


def select_live_formats(info: dict) -> tuple[dict, Optional[dict]]:
    """Pick the best HLS video at or below 1080p, plus a separate audio track if needed.

    Muxed variants (Twitch) are preferred. YouTube lists video-only variants
    and audio-only playlists instead.
    """
    hls = [fmt for fmt in info.get("formats") or []
           if isinstance(fmt, dict) and fmt.get("protocol") in ("m3u8", "m3u8_native") and fmt.get("url")]

    def usable_video(fmt: dict) -> bool:
        height = fmt.get("height") or 0
        return _has(fmt, "vcodec") and isinstance(height, (int, float)) and height <= MAX_LIVE_HEIGHT

    def video_rank(fmt: dict):
        return (fmt.get("height") or 0, fmt.get("fps") or 0, fmt.get("tbr") or 0)

    muxed = [fmt for fmt in hls if usable_video(fmt) and _has(fmt, "acodec")]
    if muxed:
        return max(muxed, key=video_rank), None
    video = [fmt for fmt in hls if usable_video(fmt) and fmt.get("acodec") == "none"]
    audio = [fmt for fmt in hls if fmt.get("vcodec") == "none" and not fmt.get("height")]
    if not video or not audio:
        raise LiveCaptureError("No recordable live format", "no_live_format")
    return (max(video, key=video_rank),
            max(audio, key=lambda fmt: (fmt.get("abr") or fmt.get("tbr") or 0, str(fmt.get("format_id")))))


def _is_not_live_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in NOT_LIVE_MARKERS)


def extract_live_info(channel: LiveChannel, deadline: Optional[float] = None) -> dict:
    """Ask yt-dlp for the channel's live metadata through guarded sockets."""
    import yt_dlp

    from clip_engine.network_policy import guarded_public_connections
    from clip_engine.services.media_process import guarded_ytdlp_children

    opts = {
        "proxy": "", "external_downloader": "native", "hls_prefer_native": True,
        "skip_download": True, "noplaylist": True, "socket_timeout": 30,
        "nocheckcertificate": False, "geo_bypass": True, "quiet": True, "no_warnings": True,
        "allowed_extractors": LIVE_EXTRACTORS[channel.platform],
    }
    with guarded_ytdlp_children(deadline), guarded_public_connections():
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(channel.url, download=False)


def resolve_live_stream(channel: LiveChannel, extract: Callable[[LiveChannel], dict] = extract_live_info) -> Optional[LiveStream]:
    """Return the live playlist, or None when the channel is not live right now."""
    try:
        info = extract(channel)
    except Exception as exc:
        if _is_not_live_error(exc):
            return None
        raise LiveCaptureError("Live stream could not be resolved", "resolve_failed") from exc
    if not isinstance(info, dict) or not (info.get("is_live") is True or info.get("live_status") == "is_live"):
        return None
    fmt, audio = select_live_formats(info)
    channel_name = info.get("uploader") or info.get("channel") or info.get("uploader_id") or channel.url.rsplit("/", 2)[-2]
    return LiveStream(
        playlist_url=fmt["url"],
        title=str(info.get("title") or channel_name)[:200],
        channel=str(channel_name)[:100],
        platform=channel.platform,
        height=int(fmt.get("height") or 0),
        audio_playlist_url=audio["url"] if audio else None,
    )


def _attribute(line: str, name: str) -> Optional[str]:
    match = re.search(rf'(?:^|,){name}=("[^"]*"|[^,]*)', line)
    return match.group(1).strip('"') if match else None


def parse_media_playlist(text: str, base_url: str) -> MediaPlaylist:
    """Parse an HLS media playlist. Encrypted and fMP4 playlists are refused."""
    lines = [line.strip() for line in text.splitlines()]
    if not lines or lines[0] != "#EXTM3U":
        raise LiveCaptureError("Invalid live playlist", "invalid_playlist")
    if any(line.startswith("#EXT-X-STREAM-INF") for line in lines):
        raise LiveCaptureError("Expected a media playlist", "invalid_playlist")
    target = 6.0
    sequence = 0
    ended = False
    pending_duration: Optional[float] = None
    pending_title = ""
    discontinuity = False
    init_uri: Optional[str] = None
    segments: list[Segment] = []
    for line in lines[1:]:
        if not line:
            continue
        if line.startswith("#EXT-X-TARGETDURATION:"):
            target = max(1.0, min(float(line.split(":", 1)[1]), 30.0))
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            sequence = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-KEY:"):
            if (_attribute(line.split(":", 1)[1], "METHOD") or "NONE").upper() != "NONE":
                raise LiveCaptureError("Encrypted live streams are not supported", "encrypted_stream")
        elif line.startswith("#EXT-X-MAP:"):
            attributes = line.split(":", 1)[1]
            uri = _attribute(attributes, "URI")
            if not uri or _attribute(attributes, "BYTERANGE"):
                raise LiveCaptureError("This live stream format is not supported", "unsupported_stream")
            init_uri = urljoin(base_url, uri)
        elif line.startswith("#EXT-X-DISCONTINUITY") and not line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
            discontinuity = True
        elif line.startswith("#EXT-X-ENDLIST"):
            ended = True
        elif line.startswith("#EXTINF:"):
            value, _, title = line.split(":", 1)[1].partition(",")
            pending_duration = float(value)
            pending_title = title.strip()
        elif not line.startswith("#"):
            if pending_duration is None or not (0 < pending_duration <= 60):
                raise LiveCaptureError("Invalid live playlist", "invalid_playlist")
            segments.append(Segment(sequence + len(segments), urljoin(base_url, line), pending_duration,
                                    pending_title, discontinuity, init_uri))
            pending_duration = None
            pending_title = ""
            discontinuity = False
    return MediaPlaylist(target, sequence, segments, ended)


def is_ad_segment(segment: Segment, platform: str) -> bool:
    """Twitch titles stream content "live"; stitched ads carry other titles."""
    return platform == "twitch" and bool(segment.title) and segment.title.lower() != "live"


def fetch_public(url: str, max_bytes: int, timeout: float = REQUEST_TIMEOUT_SECONDS) -> tuple[bytes, str]:
    """GET a public URL with the address pinned and every redirect re-checked."""
    import httpx

    from clip_engine.network_policy import resolve_public_destination

    current = url
    with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        for redirect_count in range(6):
            try:
                destination = resolve_public_destination(current)
            except ValueError as exc:
                raise LiveCaptureError("Live destination is not public", "not_public") from exc
            with client.stream("GET", destination.url, headers={"Host": destination.host_header},
                               extensions={"sni_hostname": destination.hostname}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location or redirect_count == 5:
                        raise LiveCaptureError("Live redirect could not be followed", "redirect")
                    current = urljoin(current, location)
                    continue
                if response.status_code in (403, 404, 410):
                    raise PlaylistExpired()
                response.raise_for_status()
                body = bytearray()
                for piece in response.iter_bytes():
                    body.extend(piece)
                    if len(body) > max_bytes:
                        raise LiveCaptureError("Live response exceeded the size limit", "too_large")
                return bytes(body), current
    raise LiveCaptureError("Live redirect could not be followed", "redirect")


def remux_chunk(video_path: str, mp4_path: str, audio_path: Optional[str] = None, *,
                video_format: str = "mpegts", audio_format: str = "aac") -> None:
    """Copy local media (and a separate audio track) into MP4 without re-encoding or network access.

    ``video_format``/``audio_format`` are "mpegts", "aac" or "mov" (fragmented MP4).
    """
    if video_format not in ("mpegts", "mov") or audio_format not in ("aac", "mov"):
        raise ValueError("Unsupported live chunk format")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-protocol_whitelist", "file", "-format_whitelist", video_format,
           "-fflags", "+genpts+discardcorrupt", "-f", video_format, "-i", video_path]
    if audio_path:
        cmd += ["-protocol_whitelist", "file", "-format_whitelist", audio_format, "-f", audio_format, "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0"]
    else:
        cmd += ["-map", "0:v:0", "-map", "0:a:0?"]
    cmd += ["-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", mp4_path]
    run_media(cmd, timeout=REMUX_TIMEOUT_SECONDS, check=True)


def chunk_filename(channel: str, started: time.struct_time, part: int) -> str:
    """Readable name: it becomes the run's title in the library."""
    safe = re.sub(r"[^\w .-]+", "", channel, flags=re.UNICODE).strip(" .") or "live"
    return f"{safe[:60]} live {time.strftime('%Y-%m-%d %H.%M', started)} (part {part}).mp4"


class HlsCapture:
    """Record a live HLS stream into overlapping chunks until it ends or is stopped.

    ``on_chunk`` runs on the capture thread for every finished chunk; the caller
    owns the MP4 and deletes it once processed.
    """

    def __init__(self, channel: LiveChannel, work_dir: str, on_chunk: Callable[[Chunk], None], *,
                 chunk_seconds: float = 600, overlap_seconds: float = 90,
                 resolve: Callable[[LiveChannel], Optional[LiveStream]] = resolve_live_stream,
                 fetch: Callable[[str, int], tuple[bytes, str]] = fetch_public,
                 remux: Callable[..., None] = remux_chunk,
                 clock: Callable[[], float] = time.monotonic,
                 stop_event: Optional[threading.Event] = None,
                 offline_polls: int = 3,
                 max_session_seconds: float = MAX_SESSION_SECONDS,
                 on_status: Callable[[str], None] = lambda status: None,
                 on_progress: Callable[[int, float, float, int, int], None] = lambda *progress: None):
        if not 60 <= chunk_seconds <= 3600 or not 0 <= overlap_seconds < chunk_seconds / 2:
            raise ValueError("Invalid chunk settings")
        self.channel = channel
        self.work_dir = work_dir
        self.on_chunk = on_chunk
        self.chunk_seconds = chunk_seconds
        self.overlap_seconds = overlap_seconds
        self.resolve = resolve
        self.fetch = fetch
        self.remux = remux
        self.clock = clock
        self.stop_event = stop_event or threading.Event()
        self.offline_polls = offline_polls
        self.max_session_seconds = max_session_seconds
        self.on_status = on_status
        self.on_progress = on_progress
        self.segments_dir = os.path.join(work_dir, "segments")
        self.stream: Optional[LiveStream] = None
        self.started = time.localtime()
        self.part = 0
        self.content_seconds = 0.0
        self.gaps = 0
        self.skipped_ads = 0
        self.current: list[Recorded] = []
        self.lead_in: list[Recorded] = []
        # Init segment URI -> local copy, for fragmented MP4 streams.
        self.inits: dict[str, str] = {}

    def run(self) -> str:
        """Return why recording stopped: "offline", "ended", "stopped" or "limit"."""
        os.makedirs(self.segments_dir, exist_ok=True)
        self.stream = self.resolve(self.channel)
        if self.stream is None:
            return "offline"
        self.on_status("recording")
        began = self.clock()
        last_sequence: Optional[int] = None
        waiting: dict[int, Segment] = {}
        misses = 0
        try:
            while True:
                if self.stop_event.is_set():
                    self._flush(final=True)
                    return "stopped"
                if self.clock() - began > self.max_session_seconds:
                    self._flush(final=True)
                    return "limit"
                try:
                    playlist = self._playlist(self.stream.playlist_url)
                    audio = ({s.sequence: s for s in self._playlist(self.stream.audio_playlist_url).segments}
                             if self.stream.audio_playlist_url else None)
                except PlaylistExpired:
                    stream = self.resolve(self.channel)
                    if stream is None:
                        misses += 1
                        if misses >= self.offline_polls:
                            self._flush(final=True)
                            return "ended"
                        self.stop_event.wait(10)
                        continue
                    self.stream = stream
                    misses = 0
                    continue
                misses = 0
                # Segments already seen but not recorded yet wait here: the video
                # playlist slides on while a lagging audio playlist catches up.
                seen = max([last_sequence if last_sequence is not None else -1, *waiting])
                fresh = [s for s in playlist.segments if seen < 0 or s.sequence > seen]
                if fresh and seen >= 0 and fresh[0].sequence > seen + 1:
                    self.gaps += 1
                    logger.warning("Live playlist skipped %d segment(s)", fresh[0].sequence - seen - 1)
                waiting.update((s.sequence, s) for s in fresh)
                while len(waiting) > MAX_WAITING_SEGMENTS:
                    last_sequence = waiting.pop(min(waiting)).sequence
                    self.gaps += 1
                for sequence in sorted(waiting):
                    if self.stop_event.is_set():
                        break
                    segment = waiting[sequence]
                    audio_segment = None
                    if audio is not None:
                        audio_segment = audio.get(sequence)
                        if audio_segment is None:
                            if not audio or max(audio) < sequence:
                                break  # the audio playlist lags behind; retry on the next poll
                            self.gaps += 1
                            last_sequence = waiting.pop(sequence).sequence
                            continue
                    del waiting[sequence]
                    last_sequence = sequence
                    if is_ad_segment(segment, self.stream.platform):
                        self.skipped_ads += 1
                        continue
                    self._record(segment, audio_segment)
                    if sum(item.duration for item in self.current) >= self.chunk_seconds:
                        self._flush(final=False)
                # Part being recorded, its new content so far and its target length.
                self.on_progress(self.part + 1, sum(item.duration for item in self.current), self.chunk_seconds,
                                 self.gaps, self.skipped_ads)
                if playlist.ended:
                    self._flush(final=True)
                    return "ended"
                self.stop_event.wait(max(1.0, min(playlist.target_duration / 2, 6.0)))
        finally:
            shutil.rmtree(self.segments_dir, ignore_errors=True)

    def _playlist(self, url: str) -> MediaPlaylist:
        body, final_url = self.fetch(url, MAX_PLAYLIST_BYTES)
        return parse_media_playlist(body.decode("utf-8", errors="replace"), final_url)

    def _download(self, uri: str) -> Optional[bytes]:
        for attempt in range(SEGMENT_ATTEMPTS):
            try:
                data, _ = self.fetch(uri, MAX_SEGMENT_BYTES)
                return data
            except PlaylistExpired:
                return None
            except LiveCaptureError:
                raise
            except Exception:
                if attempt == SEGMENT_ATTEMPTS - 1:
                    return None
                self.stop_event.wait(1)
        return None

    def _init(self, uri: Optional[str]) -> Optional[str]:
        """Local copy of a fragmented MP4 init segment, downloaded once."""
        if uri is None or uri in self.inits:
            return self.inits.get(uri) if uri else None
        if len(self.inits) >= MAX_INIT_SEGMENTS:
            raise LiveCaptureError("Live stream changed format too often", "unsupported_stream")
        for attempt in range(SEGMENT_ATTEMPTS):
            try:
                data, _ = self.fetch(uri, MAX_INIT_BYTES)
                break
            except LiveCaptureError:
                raise
            except Exception:
                if attempt == SEGMENT_ATTEMPTS - 1:
                    return None
                self.stop_event.wait(1)
        path = os.path.join(self.segments_dir, f"init-{len(self.inits)}.mp4")
        with open(path, "wb") as handle:
            handle.write(data)
        self.inits[uri] = path
        return path

    def _record(self, segment: Segment, audio_segment: Optional[Segment] = None) -> None:
        init = self._init(segment.init_uri)
        audio_init = self._init(audio_segment.init_uri) if audio_segment else None
        if (segment.init_uri and not init) or (audio_segment and audio_segment.init_uri and not audio_init):
            self.gaps += 1
            return
        # Keep the tracks aligned: a segment counts only when every track arrived.
        video = self._download(segment.uri)
        audio = self._download(audio_segment.uri) if audio_segment else None
        if video is None or (audio_segment and audio is None):
            self.gaps += 1
            logger.warning("Live segment could not be downloaded; continuing")
            return
        # One chunk decodes with one init segment: a new one (e.g. a quality
        # change) closes the chunk being built and starts a fresh one.
        if self.current and (self.current[-1].init_path, self.current[-1].audio_init_path) != (init, audio_init):
            self._flush(final=False)
            self._discard(self.lead_in)
            self.lead_in = []
        path = os.path.join(self.segments_dir, f"{segment.sequence}.{'m4s' if init else 'ts'}")
        with open(path, "wb") as handle:
            handle.write(video)
        audio_path = None
        if audio is not None:
            audio_path = os.path.join(self.segments_dir, f"{segment.sequence}.{'a.m4s' if audio_init else 'aac'}")
            with open(audio_path, "wb") as handle:
                handle.write(audio)
        self.current.append(Recorded(path, audio_path, segment.duration, self.content_seconds, init, audio_init))
        self.content_seconds += segment.duration

    def _flush(self, final: bool) -> None:
        new_seconds = sum(item.duration for item in self.current)
        if not self.current or (final and new_seconds < MIN_FINAL_CHUNK_SECONDS):
            self._discard(self.lead_in + self.current)
            self.lead_in, self.current = [], []
            return
        if self.lead_in and (self.lead_in[0].init_path, self.lead_in[0].audio_init_path) != \
                (self.current[0].init_path, self.current[0].audio_init_path):
            self._discard(self.lead_in)
            self.lead_in = []
        self.part += 1
        items = self.lead_in + self.current
        first = items[0]
        lead_in_seconds = sum(item.duration for item in self.lead_in)
        video_path = os.path.join(self.work_dir, f"part-{self.part}.{'m4s' if first.init_path else 'ts'}")
        audio_path = (os.path.join(self.work_dir, f"part-{self.part}.{'a.m4s' if first.audio_init_path else 'aac'}")
                      if first.audio_path else None)
        mp4_path = os.path.join(self.work_dir, chunk_filename(self.stream.channel, self.started, self.part))
        try:
            _concatenate(([first.init_path] if first.init_path else []) + [item.path for item in items], video_path)
            if audio_path:
                _concatenate(([first.audio_init_path] if first.audio_init_path else []) + [item.audio_path for item in items],
                             audio_path)
            self.remux(video_path, mp4_path, audio_path,
                       video_format="mov" if first.init_path else "mpegts",
                       audio_format="mov" if first.audio_init_path else "aac")
        finally:
            _remove(video_path)
            if audio_path:
                _remove(audio_path)
        # Keep the tail of this chunk as the next chunk's lead-in so moments
        # that straddle a boundary are seen whole at least once.
        tail: deque = deque()
        tail_seconds = 0.0
        for item in reversed(self.current):
            if tail_seconds >= self.overlap_seconds:
                break
            tail.appendleft(item)
            tail_seconds += item.duration
        self._discard([item for item in items if item not in tail])
        self.lead_in, self.current = ([] if final else list(tail)), []
        if final:
            self._discard(tail)
        self.on_chunk(Chunk(
            part=self.part,
            path=mp4_path,
            stream_offset_seconds=first.offset,
            duration_seconds=sum(item.duration for item in items),
            lead_in_seconds=lead_in_seconds,
        ))

    @staticmethod
    def _discard(items: Iterable[Recorded]) -> None:
        for item in items:
            _remove(item.path)
            if item.audio_path:
                _remove(item.audio_path)


def _concatenate(paths: list[str], output: str) -> None:
    written = 0
    with open(output, "wb") as out:
        for path in paths:
            with open(path, "rb") as handle:
                while block := handle.read(1024 * 1024):
                    written += len(block)
                    if written > MAX_CHUNK_BYTES:
                        raise LiveCaptureError("Live chunk exceeded the size limit", "too_large")
                    out.write(block)


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
