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
    ('https://kick.com/Some_Streamer', ('kick', 'https://kick.com/some_streamer')),
    ('https://www.kick.com/some-streamer/', ('kick', 'https://kick.com/some-streamer')),
])
def test_channel_urls_are_canonical(url, expected):
    channel = module.live_channel(url)
    assert (channel.platform, channel.url) == expected


@pytest.mark.parametrize('url', [
    'http://www.twitch.tv/streamer', 'https://www.twitch.tv/videos/123', 'https://www.twitch.tv/a/b',
    'https://twitch.tv.evil.test/streamer', 'https://user:pw@twitch.tv/streamer', 'https://twitch.tv:8443/streamer',
    'https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/@x', 'https://www.youtube.com/channel/UCshort',
    'https://example.com/@handle', 'not a url', 'https://www.twitch.tv/' + 'a' * 26,
    'https://kick.com/categories', 'https://kick.com/x/videos/123', 'https://kick.com/a', 'http://kick.com/streamer',
    'https://kick.com.evil.test/streamer',
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
    video, audio = module.select_live_formats(info)
    assert (video['url'], audio) == ('c', None)
    with pytest.raises(LiveCaptureError):
        module.select_live_formats({'formats': [{'protocol': 'https', 'url': 'x'}]})


def test_youtube_split_tracks_pick_video_and_audio_playlists():
    # YouTube live: audio-only 233/234 and video-only variants, no muxed format.
    info = {'formats': [
        {'format_id': '233', 'protocol': 'm3u8_native', 'url': 'a1', 'vcodec': 'none', 'acodec': None},
        {'format_id': '234', 'protocol': 'm3u8_native', 'url': 'a2', 'vcodec': 'none', 'acodec': None},
        {'format_id': '232', 'protocol': 'm3u8_native', 'url': 'v720', 'height': 720, 'vcodec': 'avc1', 'acodec': 'none'},
        {'format_id': '270', 'protocol': 'm3u8_native', 'url': 'v1080', 'height': 1080, 'vcodec': 'avc1', 'acodec': 'none'},
    ]}
    video, audio = module.select_live_formats(info)
    assert (video['url'], audio['url']) == ('v1080', 'a2')
    with pytest.raises(LiveCaptureError):
        module.select_live_formats({'formats': info['formats'][2:]})


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


def test_stream_start_prefers_the_broadcast_start_and_rejects_nonsense():
    now = 2_000_000_000
    assert module.stream_start({'release_timestamp': 1_999_990_000, 'timestamp': 1_999_000_000}, now) == 1_999_990_000
    assert module.stream_start({'release_timestamp': None, 'timestamp': 1_999_995_000}, now) == 1_999_995_000
    for info in ({}, {'timestamp': 'x'}, {'timestamp': True}, {'timestamp': -5}, {'release_timestamp': now + 3600}):
        assert module.stream_start(info, now) is None


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
    ('#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"', 'unsupported_stream'),
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


def run_capture(tmp_path, stream, audio_url=None, **kwargs):
    chunks = []
    resolves = []

    def resolve(channel):
        resolves.append(channel)
        return LiveStream('https://cdn.test/live.m3u8', 'title', 'Streamer', 'twitch', 1080, audio_url)

    def remux(ts_path, mp4_path, audio_path=None, **formats):
        with open(ts_path, 'rb') as src, open(mp4_path, 'wb') as dst:
            dst.write(src.read())
            if audio_path:
                with open(audio_path, 'rb') as sound:
                    dst.write(b'|' + sound.read())

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
    assert name == 'Streamer live 2026-09-27 21.10 (part 3).mp4'


class SplitStream(FakeStream):
    """Video and audio playlists with shared numbering; audio can lag or lose segments."""

    def __init__(self, total, audio_lag=0, missing_audio=(), **kwargs):
        super().__init__(total, **kwargs)
        self.audio_lag, self.missing_audio = audio_lag, set(missing_audio)

    def fetch(self, url, max_bytes):
        if url.endswith('audio.m3u8'):
            available = max(0, self.available - self.audio_lag)
            first = max(0, available - 6)
            lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', f'#EXT-X-MEDIA-SEQUENCE:{first}']
            for n in range(first, available):
                lines += ['#EXTINF:2.0,', f'aud{n}.aac']
            return '\n'.join(lines).encode(), url
        if url.endswith('.aac') and int(url.rsplit('aud', 1)[1][:-4]) in self.missing_audio:
            raise OSError('reset')
        return super().fetch(url, max_bytes)


def test_split_audio_is_recorded_alongside_video(tmp_path):
    stream = SplitStream(40, audio_lag=3)
    _, reason, chunks, _ = run_capture(tmp_path, stream, audio_url='https://cdn.test/audio.m3u8',
                                       chunk_seconds=60, overlap_seconds=0)
    assert reason == 'ended'
    video, audio = chunks[0][1].split('|')
    assert video.startswith('seg0.tsseg1.ts') and audio.startswith('aud0.aacaud1.aac')
    assert video.count('.ts') == audio.count('.aac') == 30


def test_segments_missing_a_track_are_dropped_to_keep_sync(tmp_path):
    capture, _, chunks, _ = run_capture(tmp_path, SplitStream(40, missing_audio={3}),
                                        audio_url='https://cdn.test/audio.m3u8', chunk_seconds=60, overlap_seconds=0)
    video, audio = chunks[0][1].split('|')
    assert 'seg3.ts' not in video and 'aud3.aac' not in audio
    assert capture.gaps == 1


def test_fragmented_mp4_segments_carry_their_init_segment():
    text = '\n'.join(['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-MAP:URI="init-a.mp4"',
                      '#EXTINF:2.0,live', 's7.m4s', '#EXT-X-MAP:URI="init-b.mp4"', '#EXTINF:2.0,live', 's8.m4s'])
    parsed = module.parse_media_playlist(text, 'https://cdn.test/v/index.m3u8')
    assert [s.init_uri for s in parsed.segments] == ['https://cdn.test/v/init-a.mp4', 'https://cdn.test/v/init-b.mp4']


class Fmp4Stream(FakeStream):
    """Twitch-style fragmented MP4: every playlist names its init segment."""

    def __init__(self, total, switch_at=None, **kwargs):
        super().__init__(total, **kwargs)
        self.switch_at = switch_at
        self.init_fetches = 0

    def fetch(self, url, max_bytes):
        if url.endswith('.m3u8'):
            body, final = super().fetch(url, max_bytes)
            lines = body.decode().split('\n')
            out, first = [], int(lines[2].split(':')[1])
            for line in lines:
                if line.startswith('seg'):
                    n = int(line[3:-3])
                    init = 'init-b.mp4' if self.switch_at is not None and n >= self.switch_at else 'init-a.mp4'
                    out += [f'#EXT-X-MAP:URI="{init}"', line.replace('.ts', '.m4s')]
                else:
                    out.append(line)
            return '\n'.join(out).encode(), final
        if 'init-' in url:
            self.init_fetches += 1
            return url.rsplit('/', 1)[1].encode(), url
        return url.rsplit('/', 1)[1].encode(), url


def test_fragmented_chunks_start_with_their_init_segment(tmp_path):
    stream = Fmp4Stream(80)
    capture, _, chunks, _ = run_capture(tmp_path, stream, chunk_seconds=60, overlap_seconds=10)
    assert [c.part for c, _ in chunks] == [1, 2, 3]  # 60 + 60 + 40 s
    for _, text in chunks:
        assert text.startswith('init-a.mp4seg') and text.count('init-a.mp4') == 1
    assert stream.init_fetches == 1, 'the init segment is downloaded once'


def test_a_new_init_segment_starts_a_new_chunk(tmp_path):
    capture, _, chunks, _ = run_capture(tmp_path, Fmp4Stream(60, switch_at=20), chunk_seconds=60, overlap_seconds=10)
    # 40 s with init A (flushed early), then 80 s with init B and no lead-in from A.
    first, second = chunks[0], chunks[1]
    assert first[1].startswith('init-a.mp4') and 'init-b' not in first[1]
    assert second[1].startswith('init-b.mp4seg20.m4s') and 'init-a' not in second[1]
    assert (first[0].duration_seconds, second[0].lead_in_seconds) == (40, 0)


@pytest.mark.skipif(not __import__('shutil').which('ffmpeg'), reason='needs ffmpeg')
def test_real_remux_of_fragmented_mp4(tmp_path):
    import subprocess
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi',
                    '-i', 'sine', '-t', '6', '-c:v', 'libx264', '-g', '30', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2',
                    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
                    '-hls_segment_filename', 's%d.m4s', 'x.m3u8'], check=True, cwd=tmp_path)
    parts = [tmp_path / 'init.mp4'] + sorted(tmp_path.glob('s*.m4s'), key=lambda p: int(p.stem[1:]))
    joined = tmp_path / 'joined.m4s'
    joined.write_bytes(b''.join(p.read_bytes() for p in parts))
    out = tmp_path / 'out.mp4'
    module.remux_chunk(str(joined), str(out), video_format='mov')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'csv=p=0',
                            str(out)], capture_output=True, text=True, check=True).stdout.split()
    assert 'video' in probe and 'audio' in probe
    assert abs(float(probe[-1]) - 6) < 0.3
