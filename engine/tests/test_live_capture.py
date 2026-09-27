"""Live capture: channel validation, playlist parsing and chunked recording."""
import os
import threading

import pytest

from clip_engine.services import live_capture as module
from clip_engine.services.live_capture import (
    Chunk, HlsCapture, LiveCaptureError, LiveChannel, LiveStream, PlaylistExpired,
)


@pytest.mark.parametrize('url, expected', [
    ('https://www.twitch.tv/Streamer_1', ('twitch', 'https://www.twitch.tv/streamer_1')),
    ('https://twitch.tv/streamer/', ('twitch', 'https://www.twitch.tv/streamer')),
    ('https://www.youtube.com/@Some.Channel', ('youtube', 'https://www.youtube.com/@Some.Channel/live')),
    ('https://youtube.com/@handle/live', ('youtube', 'https://www.youtube.com/@handle/live')),
    ('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', ('youtube', 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/live')),
])
def test_channel_urls_are_canonical(url, expected):
    channel = module.live_channel(url)
    assert (channel.platform, channel.url) == expected


@pytest.mark.parametrize('url', [
    'http://www.twitch.tv/streamer', 'https://www.twitch.tv/videos/123', 'https://www.twitch.tv/a/b',
    'https://twitch.tv.evil.test/streamer', 'https://user:pw@twitch.tv/streamer', 'https://twitch.tv:8443/streamer',
    'https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/@x', 'https://www.youtube.com/channel/UCshort',
    'https://example.com/@handle', 'not a url', 'https://www.twitch.tv/' + 'a' * 26,
])
def test_other_urls_are_refused(url):
    with pytest.raises(LiveCaptureError) as error:
        module.live_channel(url)
    assert error.value.reason == 'unsupported_channel'


def test_format_selection_prefers_best_muxed_hls_at_or_below_1080p():
    info = {'formats': [
        {'protocol': 'm3u8_native', 'url': 'a', 'height': 1440, 'vcodec': 'avc1', 'acodec': 'mp4a'},
        {'protocol': 'm3u8_native', 'url': 'b', 'height': 1080, 'fps': 30, 'vcodec': 'avc1', 'acodec': 'mp4a'},
        {'protocol': 'm3u8_native', 'url': 'c', 'height': 1080, 'fps': 60, 'vcodec': 'avc1', 'acodec': 'mp4a'},
        {'protocol': 'm3u8_native', 'url': 'd', 'height': 1080, 'fps': 60, 'vcodec': 'avc1', 'acodec': 'none'},
        {'protocol': 'https', 'url': 'e', 'height': 720, 'vcodec': 'avc1', 'acodec': 'mp4a'},
    ]}
    assert module.select_live_format(info)['url'] == 'c'
    with pytest.raises(LiveCaptureError):
        module.select_live_format({'formats': [{'protocol': 'https', 'url': 'x'}]})


def test_resolve_distinguishes_offline_from_failure():
    channel = LiveChannel('twitch', 'https://www.twitch.tv/streamer')

    def offline(_):
        raise Exception('streamer: The channel is not currently live')

    def broken(_):
        raise Exception('HTTP Error 500')

    assert module.resolve_live_stream(channel, offline) is None
    assert module.resolve_live_stream(channel, lambda _: {'is_live': False}) is None
    with pytest.raises(LiveCaptureError):
        module.resolve_live_stream(channel, broken)
    stream = module.resolve_live_stream(channel, lambda _: {
        'is_live': True, 'title': 'Big game', 'uploader': 'Streamer',
        'formats': [{'protocol': 'm3u8_native', 'url': 'https://cdn.test/v.m3u8', 'height': 720,
                     'vcodec': 'avc1', 'acodec': 'mp4a'}],
    })
    assert stream == LiveStream('https://cdn.test/v.m3u8', 'Big game', 'Streamer', 'twitch', 720)


def playlist(first, count, *, duration=2.0, titles=None, ended=False, extra=''):
    lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', f'#EXT-X-MEDIA-SEQUENCE:{first}', extra]
    for index in range(count):
        title = (titles or {}).get(first + index, 'live')
        lines += [f'#EXTINF:{duration},{title}', f'seg{first + index}.ts']
    if ended:
        lines.append('#EXT-X-ENDLIST')
    return '\n'.join(lines)


def test_parser_numbers_segments_and_resolves_uris():
    parsed = module.parse_media_playlist(playlist(40, 3, ended=True), 'https://cdn.test/live/index.m3u8')
    assert [s.sequence for s in parsed.segments] == [40, 41, 42]
    assert parsed.segments[0].uri == 'https://cdn.test/live/seg40.ts'
    assert parsed.ended and parsed.target_duration == 2


@pytest.mark.parametrize('extra, reason', [
    ('#EXT-X-KEY:METHOD=AES-128,URI="k"', 'encrypted_stream'),
    ('#EXT-X-MAP:URI="init.mp4"', 'unsupported_stream'),
    ('#EXT-X-STREAM-INF:BANDWIDTH=1', 'invalid_playlist'),
])
def test_parser_refuses_unsupported_playlists(extra, reason):
    with pytest.raises(LiveCaptureError) as error:
        module.parse_media_playlist(playlist(0, 1, extra=extra), 'https://cdn.test/')
    assert error.value.reason == reason


def test_twitch_ad_segments_are_detected():
    ad = module.Segment(1, 'u', 2.0, 'Amazon|123')
    assert module.is_ad_segment(ad, 'twitch')
    assert not module.is_ad_segment(module.Segment(1, 'u', 2.0, 'live'), 'twitch')
    assert not module.is_ad_segment(ad, 'youtube')


class FakeStream:
    """Serves a growing live playlist; each fetch of it advances the stream."""

    def __init__(self, total, per_poll=5, ads=(), expire_at=None, end=True):
        self.total, self.per_poll, self.ads, self.expire_at, self.end = total, per_poll, set(ads), expire_at, end
        self.available = 0
        self.playlist_fetches = 0
        self.expired = False

    def fetch(self, url, max_bytes):
        if url.endswith('.m3u8'):
            self.playlist_fetches += 1
            if self.expire_at is not None and self.playlist_fetches == self.expire_at and not self.expired:
                self.expired = True
                raise PlaylistExpired()
            self.available = min(self.total, self.available + self.per_poll)
            first = max(0, self.available - 6)
            titles = {n: 'Amazon' for n in self.ads}
            text = playlist(first, self.available - first, titles=titles,
                            ended=self.end and self.available == self.total)
            return text.encode(), url
        return url.rsplit('/', 1)[1].encode(), url


def run_capture(tmp_path, stream, **kwargs):
    chunks = []
    resolves = []

    def resolve(channel):
        resolves.append(channel)
        return LiveStream('https://cdn.test/live.m3u8', 'title', 'Streamer', 'twitch', 1080)

    def remux(ts_path, mp4_path):
        with open(ts_path, 'rb') as src, open(mp4_path, 'wb') as dst:
            dst.write(src.read())

    def on_chunk(chunk):
        with open(chunk.path, 'rb') as handle:
            chunks.append((chunk, handle.read().decode()))

    capture = HlsCapture(LiveChannel('twitch', 'https://www.twitch.tv/streamer'), str(tmp_path), on_chunk,
                         resolve=resolve, fetch=stream.fetch, remux=remux, **kwargs)
    capture.stop_event.wait = lambda timeout=None: capture.stop_event.is_set()
    return capture, capture.run(), chunks, resolves


def test_chunks_overlap_and_track_stream_offsets(tmp_path):
    # 110 segments x 2 s = 220 s; 60 s chunks with a 10 s lead-in.
    capture, reason, chunks, _ = run_capture(tmp_path, FakeStream(110), chunk_seconds=60, overlap_seconds=10)
    assert reason == 'ended'
    assert [c.part for c, _ in chunks] == [1, 2, 3, 4]
    first, second = chunks[0][0], chunks[1][0]
    assert (first.stream_offset_seconds, first.duration_seconds, first.lead_in_seconds) == (0, 60, 0)
    assert (second.stream_offset_seconds, second.lead_in_seconds) == (50, 10)
    assert chunks[1][1].startswith('seg25.tsseg26.ts')
    # Final remainder: 220 - 180 = 40 s of new content (plus lead-in) is kept.
    assert chunks[-1][0].stream_offset_seconds == 170
    assert not os.path.exists(os.path.join(tmp_path, 'segments'))
    assert not any(name.endswith('.ts') for name in os.listdir(tmp_path))


def test_ads_are_skipped_without_shifting_content_offsets(tmp_path):
    capture, _, chunks, _ = run_capture(tmp_path, FakeStream(40, ads=range(5, 15)), chunk_seconds=60, overlap_seconds=0)
    content = ''.join(text for _, text in chunks)
    assert 'seg5.ts' not in content and 'seg14.ts' not in content
    assert capture.skipped_ads == 10
    assert capture.content_seconds == 60


def test_expired_playlist_is_resolved_again(tmp_path):
    _, reason, chunks, resolves = run_capture(tmp_path, FakeStream(50, expire_at=3), chunk_seconds=60, overlap_seconds=0)
    assert reason == 'ended'
    assert len(resolves) == 2
    assert sum(c.duration_seconds for c, _ in chunks) == 100


def test_short_final_remainder_is_dropped(tmp_path):
    _, _, chunks, _ = run_capture(tmp_path, FakeStream(35), chunk_seconds=60, overlap_seconds=0)
    # 70 s: one full chunk, then 10 s < 30 s minimum.
    assert [c.duration_seconds for c, _ in chunks] == [60]


def test_offline_channel_records_nothing(tmp_path):
    capture = HlsCapture(LiveChannel('twitch', 'https://www.twitch.tv/x'), str(tmp_path), lambda chunk: None,
                         resolve=lambda channel: None, fetch=lambda *a: pytest.fail('no fetch'))
    assert capture.run() == 'offline'


def test_stop_flushes_what_was_recorded(tmp_path):
    stream = FakeStream(10_000, end=False)
    stop = threading.Event()
    original = stream.fetch

    def fetch(url, max_bytes):
        if stream.available >= 30:
            stop.set()
        return original(url, max_bytes)

    stream.fetch = fetch
    _, reason, chunks, _ = run_capture(tmp_path, stream, chunk_seconds=600, overlap_seconds=0, stop_event=stop)
    assert reason == 'stopped'
    assert len(chunks) == 1 and chunks[0][0].duration_seconds >= 30


def test_chunk_names_are_readable_and_safe():
    import time
    name = module.chunk_filename('Str/eam<er>', time.strptime('2026-09-27 21:10', '%Y-%m-%d %H:%M'), 3)
    assert name == 'Streamer live 2026-09-27 21h10 (partie 3).mp4'
