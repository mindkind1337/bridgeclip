"""Live chat: record a channel's chat while its stream is recorded, and summarize reactions.

Twitch chat is read anonymously over IRC on a WebSocket; Kick chat through the
public Pusher channel its web player uses. Messages keep the platform's send
time so they can be placed on a recorded chunk's timeline through the stream's
program date-time. Only counts and known reaction tokens reach the planner:
viewer text is untrusted and never sent as prompt text.
"""

import json
import logging
import random
import re
import statistics
import threading
import time
from collections import Counter, deque
from datetime import datetime
from typing import Callable, Iterable, Optional

logger = logging.getLogger(__name__)

TWITCH_CHAT_URL = "wss://irc-ws.chat.twitch.tv:443"
KICK_PUSHER_URL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false"
MAX_MESSAGES = 300_000
MAX_MESSAGE_CHARS = 500
MAX_SAVED_MESSAGES = 20_000
WINDOW_SECONDS = 10
MAX_NOTE_WINDOWS = 25

LAUGH = {"lul", "lulw", "omegalul", "kekw", "kek", "kekl", "icant", "lmao", "lmfao", "lol", "xd", "xdd", "pepelaugh",
         "😂", "🤣", "💀", "mdr", "ptdr", "jaja", "jajaja", "kappa", "lolw", "omegaroll", "aware", "jpp"}
HYPE = {"pog", "pogchamp", "poggers", "pogu", "w", "ww", "www", "letsgo", "lets", "gg", "ez", "clap", "hype", "wow",
        "🔥", "🐐", "goat", "insane", "huge", "incroyable", "masterclass", "chaud", "enorme", "énorme", "bravo"}
SHOCK = {"monkas", "wtf", "omg", "holy", "wait", "what", "😱", "😳", "noway", "nah", "monkaw", "sus", "hmm", "?", "quoi", "hein", "wsh", "wesh", "oskour"}
# Chat bots and commands are not viewer reactions.
BOTS = {"nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "sery_bot",
        "pokemoncommunitygame", "botrixoficial", "kickbot", "streamlootsbot", "commanderroot", "deepbot", "coebot",
        "vivbot", "phantombot", "own3d", "blerp", "tangiabot", "songlistbot", "lumiastream"}


def is_noise(user: Optional[str], text: str) -> bool:
    """Commands (!gamble) and known bots, which would fake reactions."""
    return text.lstrip().startswith("!") or (user or "").lower() in BOTS


# "hahaha", "ahahah" (French), "jajaja", "lool", "xDD", "mdrrr", "ptdrrr".
LAUGH_PATTERN = re.compile(r"^a?(?:ha){2,}h?$|^(?:he){2,}$|^(?:ja){2,}$|^l+o+l+$|^x+d+$|^m+d+r+$|^p+t+d+r+$")
TOKEN = re.compile(r"[\w']+|[^\w\s]", re.UNICODE)


class ChatLog:
    """Thread-safe store of (send time, text) messages."""

    def __init__(self, limit: int = MAX_MESSAGES):
        self._messages: deque = deque(maxlen=limit)
        self._lock = threading.Lock()
        self.total = 0

    def add(self, sent_at: float, text: str) -> None:
        text = " ".join(str(text).split())[:MAX_MESSAGE_CHARS]
        if not text:
            return
        with self._lock:
            self._messages.append((sent_at, text))
            self.total += 1

    def between(self, start: float, end: float) -> list[tuple[float, str]]:
        with self._lock:
            return [item for item in self._messages if start <= item[0] < end]


def place_on_timeline(messages: Iterable[tuple[float, str]], timeline: Iterable[tuple]) -> list[tuple[float, str]]:
    """Map (send time, text) onto a chunk: each timeline entry is (chunk seconds, broadcast time, length)."""
    entries = sorted(timeline, key=lambda entry: entry[1])
    placed = []
    for sent_at, text in messages:
        for position, program_time, length in entries:
            if program_time <= sent_at < program_time + length:
                placed.append((round(position + sent_at - program_time, 2), text))
                break
    placed.sort(key=lambda item: item[0])
    return placed


def reaction_kind(token: str) -> Optional[str]:
    word = token.lower()
    if word in LAUGH or LAUGH_PATTERN.match(word):
        return "laugh"
    if word in HYPE:
        return "hype"
    if word in SHOCK:
        return "shock"
    return None


def summarize(messages: list[tuple[float, str]], duration: float, window: int = WINDOW_SECONDS) -> tuple[str, dict]:
    """Planner notes and stats for chat placed on a chunk's timeline."""
    buckets = max(1, int(duration // window) + 1)
    counts = [0] * buckets
    reactions: list[Counter] = [Counter() for _ in range(buckets)]
    kinds: list[Counter] = [Counter() for _ in range(buckets)]
    for position, text in messages:
        index = min(buckets - 1, max(0, int(position // window)))
        counts[index] += 1
        seen = set()
        for token in TOKEN.findall(text):
            kind = reaction_kind(token)
            if kind and token.lower() not in seen:
                seen.add(token.lower())
                reactions[index][token.upper() if token.isalnum() else token] += 1
                kinds[index][kind] += 1
    total = sum(counts)
    if not total:
        return "", {"messages": 0}
    usual = max(1.0, statistics.median(counts))
    wanted = [i for i in range(buckets)
              if counts[i] >= max(3, 2 * usual) or kinds[i]["laugh"] >= 3 or kinds[i]["hype"] >= 5]
    wanted = sorted(sorted(wanted, key=lambda i: counts[i], reverse=True)[:MAX_NOTE_WINDOWS])
    lines = [f"Usual chat rate: about {usual:g} messages per {window} s. {total} messages in total."]
    for i in wanted:
        top = ", ".join(f"{token}×{count}" for token, count in reactions[i].most_common(4))
        mood = "/".join(kind for kind, count in kinds[i].most_common() if count >= 2)
        lines.append(f"[{i * window} - {(i + 1) * window}] {counts[i]} messages ({counts[i] / usual:.1f}x usual)"
                     + (f" · {mood}" if mood else "") + (f" · {top}" if top else ""))
    if len(lines) == 1:
        lines.append("No window stood out: the chat reacted evenly.")
    peak = max(range(buckets), key=lambda i: counts[i])
    top = reactions[peak].most_common(1)
    stats = {"messages": total, "usual_per_window": usual, "window_s": window, "peak_s": peak * window,
             "peak_count": counts[peak], "peak_reaction": top[0][0] if top else None,
             "laughs": sum(k["laugh"] for k in kinds)}
    return "\n".join(lines), stats


def laugh_peak(messages: list[tuple[float, str]], window: int = WINDOW_SECONDS, minimum: int = 3) -> Optional[float]:
    """Start of the window where most viewers laughed (at least `minimum` laughs), or None."""
    laughs: Counter = Counter()
    for position, text in messages:
        if any(reaction_kind(token) == "laugh" for token in TOKEN.findall(text)):
            laughs[int(position // window)] += 1
    if not laughs:
        return None
    index, count = max(laughs.items(), key=lambda item: (item[1], -item[0]))
    return float(index * window) if count >= minimum else None


def save_chat(path: str, messages: list[tuple[float, str]], stats: dict) -> None:
    """Keep a part's chat next to its clips (for review in the app)."""
    kept = messages[:MAX_SAVED_MESSAGES]
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "stats": stats, "truncated": len(messages) > len(kept),
                   "messages": [{"t": t, "text": text} for t, text in kept]}, handle, ensure_ascii=False)


def parse_twitch_line(line: str) -> Optional[tuple[float, str]]:
    """(send time, text) from an IRC PRIVMSG with tags, or None (also for bots and commands)."""
    if not line.startswith("@") or " PRIVMSG #" not in line:
        return None
    tags, _, rest = line[1:].partition(" ")
    user = rest[1:].split("!", 1)[0] if rest.startswith(":") else None
    fields = dict(part.split("=", 1) for part in tags.split(";") if "=" in part)
    _, _, text = rest.partition(" :")
    try:
        sent = int(fields.get("tmi-sent-ts", "")) / 1000
    except ValueError:
        sent = time.time()
    if text.startswith("\x01ACTION ") and text.endswith("\x01"):
        text = text[8:-1]
    return (sent, text) if text and not is_noise(user, text) else None


def parse_kick_event(raw: str) -> Optional[tuple[float, str]]:
    try:
        event = json.loads(raw)
        if event.get("event") != "App\\Events\\ChatMessageEvent":
            return None
        data = json.loads(event["data"]) if isinstance(event.get("data"), str) else event.get("data") or {}
        text = data.get("content")
        stamp = data.get("created_at")
        sent = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() if isinstance(stamp, str) else time.time()
    except (ValueError, TypeError, KeyError, AttributeError):
        return None
    sender = data.get("sender")
    user = sender.get("username") if isinstance(sender, dict) else None
    if not isinstance(text, str) or not text or is_noise(user, text):
        return None
    # Kick emotes arrive as [emote:ID:NAME]; keep the name, which carries the reaction.
    return sent, re.sub(r"\[emote:\d+:([^\]]+)\]", r"\1", text)


class ChatRecorder:
    """Reads one channel's chat on a background thread, reconnecting until stopped."""

    def __init__(self, platform: str, name: str, stop: threading.Event, *,
                 on_state: Callable[[str], None] = lambda state: None, connect=None, kick_chatroom=None):
        if platform not in ("twitch", "kick"):
            raise ValueError("Chat is available for Twitch and Kick")
        self.platform = platform
        self.name = name.lower()
        self.stop = stop
        self.log = ChatLog()
        self.on_state = on_state
        self._connect = connect
        self._kick_chatroom = kick_chatroom or kick_chatroom_id
        self.connected = False
        self.thread = threading.Thread(target=self._run, name=f"live-chat-{platform}", daemon=True)

    def start(self) -> "ChatRecorder":
        self.thread.start()
        return self

    def _socket(self, url: str):
        if self._connect:
            return self._connect(url)
        from websockets.sync.client import connect
        return connect(url, open_timeout=15, close_timeout=2, max_size=2 ** 20)

    def _run(self) -> None:
        delay = 2.0
        while not self.stop.is_set():
            try:
                if self.platform == "twitch":
                    self._twitch()
                else:
                    self._kick()
                delay = 2.0
            except Exception as error:
                logger.warning("Live chat disconnected (%s); reconnecting", type(error).__name__)
            if self.connected:
                self.connected = False
                self.on_state("reconnecting")
            if self.stop.wait(delay):
                return
            delay = min(delay * 2, 60)

    def _twitch(self) -> None:
        with self._socket(TWITCH_CHAT_URL) as socket:
            socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
            socket.send("PASS SCHMOOPIIE")
            socket.send(f"NICK justinfan{random.randint(10000, 99999)}")
            socket.send(f"JOIN #{self.name}")
            while not self.stop.is_set():
                try:
                    frame = socket.recv(timeout=1)
                except TimeoutError:
                    continue
                for line in str(frame).split("\r\n"):
                    if line.startswith("PING"):
                        socket.send("PONG" + line[4:])
                    elif " JOIN #" in line and not self.connected:
                        self.connected = True
                        self.on_state("connected")
                    elif message := parse_twitch_line(line):
                        self.log.add(*message)

    def _kick(self) -> None:
        chatroom = self._kick_chatroom(self.name)
        with self._socket(KICK_PUSHER_URL) as socket:
            socket.send(json.dumps({"event": "pusher:subscribe", "data": {"auth": "", "channel": f"chatrooms.{chatroom}.v2"}}))
            while not self.stop.is_set():
                try:
                    raw = socket.recv(timeout=1)
                except TimeoutError:
                    continue
                if '"pusher:ping"' in raw:
                    socket.send(json.dumps({"event": "pusher:pong", "data": {}}))
                elif "pusher_internal:subscription_succeeded" in raw and not self.connected:
                    self.connected = True
                    self.on_state("connected")
                elif message := parse_kick_event(raw):
                    self.log.add(*message)


def kick_chatroom_id(slug: str) -> int:
    """Kick's chatroom id for a channel, through yt-dlp's guarded HTTP stack."""
    import yt_dlp
    from yt_dlp.networking import Request

    from clip_engine.network_policy import guarded_public_connections

    with guarded_public_connections(), yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "proxy": ""}) as ydl:
        response = ydl.urlopen(Request(f"https://kick.com/api/v2/channels/{slug}", headers={"Accept": "application/json"}))
        data = json.loads(response.read(2_000_000))
    chatroom = (data.get("chatroom") or {}).get("id")
    if not isinstance(chatroom, int):
        raise ValueError("Kick chatroom not found")
    return chatroom
