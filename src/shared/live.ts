import { DURATION_IDS } from './job-contract'

export type LivePlatform = 'twitch' | 'youtube' | 'kick'

export interface LiveClipSettings {
  clippingMode: 'quality' | 'economy'
  aspectRatio: '9:16' | '16:9'
  durationRanges: string[]
  layoutStyle: 'auto' | 'fill' | 'fit'
  pacing: 'tight' | 'natural'
  includeCaptions: boolean
  captionPreset: string
}

export interface LiveChannel {
  id: string
  /** Canonical channel page: https://www.twitch.tv/<login>, https://kick.com/<slug> or https://www.youtube.com/@handle */
  url: string
  platform: LivePlatform
  displayName: string
  /** Checked for a live stream while BridgeClip is open. */
  enabled: boolean
  /** Clips that pass the filters are added to this automation's bank. */
  automationId: string | null
  clip: LiveClipSettings
  /** Clips scoring below this (0–1) are kept in the library but not posted. */
  minScore: number
  maxClipsPerChunk: number
  maxPostsPerHour: number
  chunkMinutes: number
  /** Always make a clip of each part's biggest chat laugh (Twitch and Kick). Missing in older channels: off. */
  chatPriority?: boolean
  createdAt: string
}

export type LiveChannelInput = Pick<LiveChannel, 'url' | 'enabled' | 'automationId' | 'clip' | 'minScore' |
  'maxClipsPerChunk' | 'maxPostsPerHour' | 'chunkMinutes' | 'chatPriority'> & { displayName?: string }

export type LiveSessionStatus = 'offline' | 'resolving' | 'recording' | 'stopping' | 'ended' | 'error'

export type LiveActivityTone = 'info' | 'good' | 'warn'

/** Saved as live.json in each clipped part's run folder: which live session and where in it. */
export interface LivePartInfo {
  version: 1
  sessionId: string
  channelId: string
  channel: string
  platform: LivePlatform
  part: number
  /** Recorded content before this part (ads excluded), and the overlap it repeats from the previous part. */
  streamOffsetSeconds: number
  leadInSeconds: number
  recordingStartedAt: string | null
  streamStartedAt: string | null
  /** [part seconds, broadcast Unix seconds, length] spans: exact broadcast time of any moment in the part. */
  timeline?: [number, number, number][]
  /** The broadcast's replay page (YouTube watch page, Twitch or Kick video), once known. */
  replayUrl?: string | null
}

const REPLAY_PATTERNS: Record<LivePlatform, RegExp> = {
  youtube: /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/,
  twitch: /^https:\/\/www\.twitch\.tv\/videos\/\d{1,20}$/,
  // Kick: the channel's past broadcasts (its video pages do not open by direct link).
  kick: /^https:\/\/kick\.com\/[A-Za-z0-9_-]{2,40}\/videos$/
}

export function isReplayUrl(value: unknown, platform: LivePlatform): value is string {
  return typeof value === 'string' && REPLAY_PATTERNS[platform]?.test(value) === true
}

export function isLiveTimeline(value: unknown): value is [number, number, number][] {
  return Array.isArray(value) && value.length <= 400 && value.every((span) => Array.isArray(span) && span.length === 3 &&
    span.every((item) => typeof item === 'number' && Number.isFinite(item)) && span[0] >= 0 && span[2] > 0)
}

/** Broadcast time (Unix seconds) of a moment in a part, from its timeline; null without timing. */
export function broadcastTime(timeline: readonly [number, number, number][] | undefined, partSeconds: number): number | null {
  if (!timeline?.length) return null
  const span = timeline.find(([start, , length]) => partSeconds >= start && partSeconds < start + length) ??
    [...timeline].reverse().find(([start]) => start <= partSeconds) ?? timeline[0]
  return span[1] + (partSeconds - span[0])
}

/** Seconds into the broadcast of a moment in a part, when both the timeline and the stream start are known. */
export function secondsIntoStream(info: Pick<LivePartInfo, 'timeline' | 'streamStartedAt'>, partSeconds: number): number | null {
  const at = broadcastTime(info.timeline, partSeconds)
  const start = info.streamStartedAt ? Date.parse(info.streamStartedAt) / 1000 : NaN
  return at !== null && Number.isFinite(start) ? Math.max(0, at - start) : null
}

/** The replay page opened at a time, in each platform's own format. */
export function replayLinkAt(url: string, platform: LivePlatform, seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (platform === 'youtube') return `${url}&t=${whole}s`
  if (platform === 'twitch') return `${url}?t=${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m${whole % 60}s`
  return url // Kick's list of broadcasts: no time in the link; the app shows the time to seek to
}

export function streamClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/** What the library knows about a run that is a part of a live. */
export interface LiveRunInfo {
  channel: string
  platform: LivePlatform | null
  part: number
  /** The broadcast's start, when the part saved it (groups parts of one live across restarts). */
  streamStartedAt: string | null
  /** When recording of this part's session began (from live.json, or the part's title). */
  recordedAt: string
}

export interface LibraryLive<T> {
  key: string
  channel: string
  platform: LivePlatform | null
  streamStartedAt: string | null
  firstRecordedAt: string
  /** Parts in order. */
  entries: T[]
}

export interface LibraryChannel<T> {
  channel: string
  platform: LivePlatform | null
  /** Newest live first. */
  lives: LibraryLive<T>[]
}

/**
 * Group library runs by channel, then by live broadcast. Parts that saved the
 * broadcast's start join that broadcast even across app restarts; older parts
 * without it join a broadcast of the same channel and day that began before
 * them, or else form one live per channel and day. Runs that are not live
 * parts are returned apart.
 */
export function groupLibraryByLive<T extends { live?: LiveRunInfo | null; date: string }>(entries: readonly T[]): { channels: LibraryChannel<T>[]; others: T[] } {
  const others: T[] = []
  const lives = new Map<string, LibraryLive<T>>()
  const day = (iso: string): string => new Date(iso).toDateString()
  const dated = entries.filter((entry) => entry.live).sort((a, b) => Number(Boolean(b.live!.streamStartedAt)) - Number(Boolean(a.live!.streamStartedAt)))
  for (const entry of entries) if (!entry.live) others.push(entry)
  for (const entry of dated) {
    const live = entry.live!
    const channelKey = live.channel.toLowerCase()
    let key: string
    if (live.streamStartedAt) key = `${channelKey}|${live.streamStartedAt}`
    else {
      const recorded = Date.parse(live.recordedAt)
      const match = [...lives.values()].filter((group) => group.channel.toLowerCase() === channelKey && group.streamStartedAt &&
        day(group.streamStartedAt) === day(live.recordedAt) && Date.parse(group.streamStartedAt) <= recorded)
        .sort((a, b) => Date.parse(b.streamStartedAt!) - Date.parse(a.streamStartedAt!))[0]
      key = match?.key ?? `${channelKey}|day|${day(live.recordedAt)}`
    }
    const group = lives.get(key) ?? { key, channel: live.channel, platform: live.platform, streamStartedAt: live.streamStartedAt,
      firstRecordedAt: live.recordedAt, entries: [] }
    if (!group.platform && live.platform) group.platform = live.platform
    if (Date.parse(live.recordedAt) < Date.parse(group.firstRecordedAt)) group.firstRecordedAt = live.recordedAt
    group.entries.push(entry)
    lives.set(key, group)
  }
  const channels = new Map<string, LibraryChannel<T>>()
  for (const group of lives.values()) {
    group.entries.sort((a, b) => Date.parse(a.live!.recordedAt) - Date.parse(b.live!.recordedAt) || a.live!.part - b.live!.part)
    const key = group.channel.toLowerCase()
    const channel = channels.get(key) ?? { channel: group.channel, platform: group.platform, lives: [] }
    if (!channel.platform && group.platform) channel.platform = group.platform
    channel.lives.push(group)
    channels.set(key, channel)
  }
  const latest = (group: LibraryLive<T>): number => Math.max(...group.entries.map((entry) => Date.parse(entry.date)))
  for (const channel of channels.values()) channel.lives.sort((a, b) => latest(b) - latest(a))
  return {
    channels: [...channels.values()].sort((a, b) => latest(b.lives[0]) - latest(a.lives[0])),
    others
  }
}

/** A channel's live as the library saw it: when it began and when its last recorded part ended. */
export interface ChannelLiveSummary {
  streamStartedAt: string | null
  firstRecordedAt: string
  /** End of the last recorded part (exact from broadcast times when known). */
  lastRecordedAt: string
}

/** A clip made from a followed channel's live, as the Live page lists it. */
export interface LiveChannelClip {
  runDir: string
  clipPath: string
  clipIndex: number
  title: string
  score: number
  part: number
  /** Seconds into the part, and into the broadcast when known. */
  startSeconds: number
  durationMs: number
  intoStream: number | null
  hasReplay: boolean
  /** When its part was recorded (from the run), for ordering. */
  recordedAt: string
  /** The chat spike this clip's moment caused, if its part kept the chat. */
  chatReaction?: { count: number; ratio: number; reaction: string | null } | null
}

/** Every part of one live session, merged in order without the overlaps. */
export interface LiveTranscript {
  channel: string
  sessionId: string | null
  recordingStartedAt: string | null
  streamStartedAt: string | null
  /** "stream": times are seconds into the broadcast (its start is known); "recording": since recording began. */
  timeBase: 'stream' | 'recording'
  parts: { part: number; runDir: string; hasTranscript: boolean; hasReplay: boolean }[]
  /** Parts between the first and last that are not in the library (failed or deleted). */
  missingParts: number[]
  /** `t` is in `timeBase` seconds; `part` numbers parts by their place in the live. */
  lines: { t: number; part: number; partSeconds: number; text: string; speaker: string | null }[]
  chat: { t: number; text: string }[]
}

export interface LiveActivity {
  at: string
  text: string
  tone: LiveActivityTone
}

/** Most recent events shown for a session. */
export const MAX_LIVE_ACTIVITY = 80

export interface LiveSessionState {
  channelId: string
  status: LiveSessionStatus
  /** Chunks clipped so far, and the one being clipped now (if any). */
  partsDone: number
  processingPart: number | null
  clipsMade: number
  clipsQueued: number
  /** The part being recorded now: new content so far, its target length, and what was skipped. */
  recording: { part: number; seconds: number; targetSeconds: number; gaps: number; ads: number } | null
  /** The broadcast's replay page, once the platform has one. */
  replayUrl?: string | null
  /** The part being clipped now and the engine's current step. */
  clipping: { part: number; step: string; percent: number } | null
  /** What the session did, oldest first. */
  activity: LiveActivity[]
  /** When the broadcast began (if the platform says) and when this session started recording it. */
  streamStartedAt?: string | null
  recordingStartedAt?: string | null
  startedAt: string | null
  endedAt: string | null
  message: string | null
}

export interface LiveOverview {
  channels: LiveChannel[]
  sessions: LiveSessionState[]
  /** Last time each channel was checked, and whether it was live. */
  checks: Record<string, { at: string; live: boolean; title: string | null }>
}

export const LIVE_LIMITS = {
  chunkMinutes: [5, 20],
  maxClipsPerChunk: [1, 5],
  maxPostsPerHour: [1, 12],
  minScore: [0, 1]
} as const

export const LIVE_OVERLAP_SECONDS = 90
/** Clips ending this close to a (non-final) part's end are cut by it: the next part has them whole. */
export const LIVE_BOUNDARY_MARGIN_SECONDS = 3

const DURATION_MAX_SECONDS: Record<string, number> = { xshort: 30, short: 60, medium: 120, long: 300 }

/**
 * Seconds each part repeats from the previous one: enough to see the longest
 * allowed clip whole plus some setup, and under half a part (the engine's limit).
 */
export function liveOverlapSeconds(durationRanges: readonly string[], chunkMinutes: number): number {
  const longest = Math.max(0, ...durationRanges.map((id) => DURATION_MAX_SECONDS[id] ?? 0))
  return Math.min(Math.floor(chunkMinutes * 60 / 2) - 1, 300, Math.max(LIVE_OVERLAP_SECONDS, longest + 30))
}
export const MAX_LIVE_CHANNELS = 30
export const MAX_LIVE_SESSIONS = 2

export const DEFAULT_LIVE_CLIP: LiveClipSettings = {
  clippingMode: 'quality',
  aspectRatio: '9:16',
  durationRanges: ['short'],
  layoutStyle: 'auto',
  pacing: 'tight',
  includeCaptions: true,
  captionPreset: 'pop'
}

export const DEFAULT_LIVE_CHANNEL: Omit<LiveChannelInput, 'url'> = {
  enabled: true,
  automationId: null,
  clip: DEFAULT_LIVE_CLIP,
  minScore: 0.7,
  maxClipsPerChunk: 2,
  maxPostsPerHour: 4,
  chunkMinutes: 10
}

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const TWITCH_RESERVED = new Set(['videos', 'directory', 'settings', 'p'])
const KICK_HOSTS = new Set(['kick.com', 'www.kick.com'])
const KICK_RESERVED = new Set(['video', 'videos', 'categories', 'category', 'search', 'auth', 'following', 'browse', 'clips',
  'settings', 'dashboard', 'terms-of-service', 'privacy-policy', 'community-guidelines'])

/**
 * Canonical channel page, or null. Mirrors live_channel() in the engine, which
 * validates again before anything is fetched.
 */
export function canonicalLiveChannel(value: unknown): { platform: LivePlatform; url: string } | null {
  if (typeof value !== 'string' || value.length > 512) return null
  let url: URL
  try { url = new URL(value.trim()) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '')
  if (TWITCH_HOSTS.has(host)) {
    const login = path.slice(1)
    if (/^[A-Za-z0-9_]{1,25}$/.test(login) && !TWITCH_RESERVED.has(login.toLowerCase())) {
      return { platform: 'twitch', url: `https://www.twitch.tv/${login.toLowerCase()}` }
    }
  } else if (KICK_HOSTS.has(host)) {
    const slug = path.slice(1)
    if (/^[A-Za-z0-9_-]{2,40}$/.test(slug) && !KICK_RESERVED.has(slug.toLowerCase())) {
      return { platform: 'kick', url: `https://kick.com/${slug.toLowerCase()}` }
    }
  } else if (YOUTUBE_HOSTS.has(host)) {
    let parts = path.slice(1).split('/')
    if (parts[parts.length - 1] === 'live') parts = parts.slice(0, -1)
    if (parts.length === 1 && /^@[A-Za-z0-9._-]{3,30}$/.test(parts[0])) return { platform: 'youtube', url: `https://www.youtube.com/${parts[0]}` }
    if (parts.length === 2 && parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1])) {
      return { platform: 'youtube', url: `https://www.youtube.com/channel/${parts[1]}` }
    }
  }
  return null
}

export function defaultLiveDisplayName(url: string): string {
  return url.replace(/\/+$/, '').split('/').pop() || url
}

function inRange(value: unknown, [low, high]: readonly [number, number], integer: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high && (!integer || Number.isInteger(value))
}

export function liveClipSettingsError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Invalid clip settings'
  const clip = value as LiveClipSettings
  if (!['quality', 'economy'].includes(clip.clippingMode)) return 'Invalid clipping mode'
  if (!['9:16', '16:9'].includes(clip.aspectRatio)) return 'Invalid aspect ratio'
  if (!['auto', 'fill', 'fit'].includes(clip.layoutStyle)) return 'Invalid layout'
  if (!['tight', 'natural'].includes(clip.pacing)) return 'Invalid pacing'
  if (typeof clip.includeCaptions !== 'boolean') return 'Invalid captions option'
  if (typeof clip.captionPreset !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(clip.captionPreset)) return 'Invalid caption preset'
  if (!Array.isArray(clip.durationRanges) || clip.durationRanges.length === 0 || clip.durationRanges.length > DURATION_IDS.length ||
      clip.durationRanges.some((item) => !DURATION_IDS.includes(item)) || new Set(clip.durationRanges).size !== clip.durationRanges.length) {
    return 'Choose at least one clip length'
  }
  // Chunks are 5–20 minutes long, so clips longer than five minutes cannot fit reliably.
  if (clip.durationRanges.some((item) => ['xlong', 'extended', 'feature'].includes(item))) return 'Live clips can be at most five minutes long'
  return null
}

/** Validate settings from the renderer; returns the normalized input or throws. */
export function parseLiveChannelInput(value: unknown): LiveChannelInput & { platform: LivePlatform; displayName: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid channel')
  const input = value as LiveChannelInput
  const channel = canonicalLiveChannel(input.url)
  if (!channel) throw new Error('Use a Twitch (twitch.tv/name), Kick (kick.com/name) or YouTube (youtube.com/@handle) channel.')
  if (typeof input.enabled !== 'boolean') throw new Error('Invalid monitoring option')
  if (input.automationId !== null && (typeof input.automationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.automationId))) throw new Error('Invalid automation')
  const clipError = liveClipSettingsError(input.clip)
  if (clipError) throw new Error(clipError)
  if (!inRange(input.minScore, LIVE_LIMITS.minScore, false)) throw new Error('Minimum score must be between 0 and 1')
  if (!inRange(input.maxClipsPerChunk, LIVE_LIMITS.maxClipsPerChunk, true)) throw new Error('Clips per part must be between 1 and 5')
  if (!inRange(input.maxPostsPerHour, LIVE_LIMITS.maxPostsPerHour, true)) throw new Error('Posts per hour must be between 1 and 12')
  if (!inRange(input.chunkMinutes, LIVE_LIMITS.chunkMinutes, true)) throw new Error('Part length must be between 5 and 20 minutes')
  if (input.chatPriority !== undefined && typeof input.chatPriority !== 'boolean') throw new Error('Invalid chat priority option')
  const name = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  if (name.length > 80 || Array.from(name).some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)) throw new Error('Use a name of up to 80 characters.')
  const clip = input.clip
  return {
    url: channel.url, platform: channel.platform, displayName: name || defaultLiveDisplayName(channel.url),
    enabled: input.enabled, automationId: input.automationId,
    clip: { clippingMode: clip.clippingMode, aspectRatio: clip.aspectRatio, durationRanges: [...clip.durationRanges],
      layoutStyle: clip.layoutStyle, pacing: clip.pacing, includeCaptions: clip.includeCaptions, captionPreset: clip.captionPreset },
    minScore: input.minScore, maxClipsPerChunk: input.maxClipsPerChunk,
    maxPostsPerHour: input.maxPostsPerHour, chunkMinutes: input.chunkMinutes, chatPriority: input.chatPriority === true
  }
}

export interface LiveClipCandidate {
  clip_index: number
  summary?: string | null
  start_time_ms: number
  end_time_ms: number
  virality_score: number
}

/** A clip already kept for posting, on the live stream's own timeline. */
export interface KeptLiveClip { start: number; end: number; keptAt: number }

export type LiveClipDecision = 'kept' | 'low_score' | 'duplicate' | 'hourly_limit' | 'boundary'

/**
 * Pick the clips of one chunk worth posting. Chunks overlap, so a moment can be
 * found twice: a clip that mostly overlaps one already kept is a duplicate.
 * Every clip gets a decision, best score first, so the activity log can say why.
 */
export function selectLiveClips(
  clips: readonly LiveClipCandidate[],
  chunk: { streamOffsetSeconds: number; durationSeconds?: number | null; final?: boolean },
  kept: readonly KeptLiveClip[],
  options: { minScore: number; maxPostsPerHour: number; now: number }
): { indices: number[]; kept: KeptLiveClip[]; decisions: { clip: LiveClipCandidate; decision: LiveClipDecision }[] } {
  const accepted = [...kept]
  const indices: number[] = []
  const decisions: { clip: LiveClipCandidate; decision: LiveClipDecision }[] = []
  const recent = (): number => accepted.filter((item) => options.now - item.keptAt < 3_600_000).length
  for (const clip of [...clips].sort((a, b) => b.virality_score - a.virality_score)) {
    const start = chunk.streamOffsetSeconds + clip.start_time_ms / 1000
    const end = chunk.streamOffsetSeconds + clip.end_time_ms / 1000
    const length = Math.max(0.001, end - start)
    const duplicate = accepted.some((item) => {
      const overlap = Math.min(end, item.end) - Math.max(start, item.start)
      return overlap > 0.5 * Math.min(length, Math.max(0.001, item.end - item.start))
    })
    const cutByEnd = !chunk.final && chunk.durationSeconds != null &&
      clip.end_time_ms / 1000 >= chunk.durationSeconds - LIVE_BOUNDARY_MARGIN_SECONDS
    let decision: LiveClipDecision = 'kept'
    if (cutByEnd) decision = 'boundary'
    else if (!(clip.virality_score >= options.minScore)) decision = 'low_score'
    else if (duplicate) decision = 'duplicate'
    else if (recent() >= options.maxPostsPerHour) decision = 'hourly_limit'
    decisions.push({ clip, decision })
    if (decision !== 'kept') continue
    accepted.push({ start, end, keptAt: options.now })
    indices.push(clip.clip_index)
  }
  return { indices, kept: accepted, decisions }
}

/** Chat reactions counted in the app (mirrors the engine's lists; used for display only). */
const CHAT_REACTIONS = new Set(['lul', 'lulw', 'omegalul', 'kekw', 'kek', 'kekl', 'icant', 'lmao', 'lmfao', 'lol', 'xd', 'xdd',
  'pepelaugh', '😂', '🤣', '💀', 'mdr', 'ptdr', 'jaja', 'jajaja', 'pog', 'pogchamp', 'poggers', 'pogu', 'w', 'omg', 'wtf', 'nah',
  'monkas', '?', 'lets', 'letsgo', 'gg', 'ez', 'clap', 'insane', 'goat', '🔥', '😱', '😳'])

export const CHAT_WINDOW_SECONDS = 10
/** How long chat takes to react to a moment: a clip's reaction is looked for up to this long after it ends. */
export const CHAT_REACTION_LAG_SECONDS = 20

export interface ChatActivity {
  /** Time of the first window, and each window's length (seconds). */
  origin: number
  window: number
  /** Messages per window, and the usual (median) count. */
  counts: number[]
  usual: number
  /** Windows where the chat reacted: at least twice the usual rate. */
  spikes: boolean[]
  topReaction: (string | null)[]
}

/**
 * Messages per window. `origin` is where the first window starts (a whole
 * live starts hours into its stream); pass `maxWindows` to widen windows so a
 * long live still fits in a readable chart.
 */
export function chatActivity(messages: readonly { t: number; text: string }[], window = CHAT_WINDOW_SECONDS,
  origin = 0, maxWindows?: number): ChatActivity | null {
  if (!messages.length) return null
  const last = Math.max(...messages.map((message) => message.t))
  if (maxWindows && (last - origin) / window > maxWindows) window = Math.ceil((last - origin) / maxWindows / 10) * 10
  const length = Math.floor((last - origin) / window) + 1
  const counts = Array.from({ length }, () => 0)
  const reactions = Array.from({ length }, () => new Map<string, number>())
  for (const message of messages) {
    const index = Math.min(length - 1, Math.max(0, Math.floor((message.t - origin) / window)))
    counts[index] += 1
    const seen = new Set<string>()
    for (const token of message.text.match(/[\p{L}\p{N}']+|[^\p{L}\p{N}\s]/gu) ?? []) {
      const word = token.toLowerCase()
      if (!CHAT_REACTIONS.has(word) && !/^(?:ha){2,}h?$|^l+o+l+$|^x+d+$/.test(word)) continue
      if (seen.has(word)) continue
      seen.add(word)
      const label = /^[\p{L}\p{N}']+$/u.test(token) ? token.toUpperCase() : token
      reactions[index].set(label, (reactions[index].get(label) ?? 0) + 1)
    }
  }
  const sorted = [...counts].sort((a, b) => a - b)
  const usual = Math.max(1, sorted[Math.floor(sorted.length / 2)])
  return {
    origin, window, counts, usual,
    spikes: counts.map((count) => count >= Math.max(3, 2 * usual)),
    topReaction: reactions.map((map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
  }
}

/** The strongest chat reaction during a clip or right after it (chat lags the moment), if the chat spiked. */
export function clipChatReaction(activity: ChatActivity | null, start: number,
  end: number): { at: number; count: number; ratio: number; reaction: string | null } | null {
  if (!activity) return null
  const { origin, window } = activity
  let best: number | null = null
  const first = Math.max(0, Math.floor((start - origin) / window))
  const last = Math.min(activity.counts.length - 1, Math.floor((end + CHAT_REACTION_LAG_SECONDS - origin) / window))
  for (let index = first; index <= last; index++) {
    if (activity.spikes[index] && (best === null || activity.counts[index] > activity.counts[best])) best = index
  }
  if (best === null) return null
  return { at: origin + best * window, count: activity.counts[best], ratio: activity.counts[best] / activity.usual, reaction: activity.topReaction[best] }
}
