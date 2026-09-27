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
  createdAt: string
}

export type LiveChannelInput = Pick<LiveChannel, 'url' | 'enabled' | 'automationId' | 'clip' | 'minScore' |
  'maxClipsPerChunk' | 'maxPostsPerHour' | 'chunkMinutes'> & { displayName?: string }

export type LiveSessionStatus = 'offline' | 'resolving' | 'recording' | 'stopping' | 'ended' | 'error'

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
  const name = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  if (name.length > 80 || Array.from(name).some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)) throw new Error('Use a name of up to 80 characters.')
  const clip = input.clip
  return {
    url: channel.url, platform: channel.platform, displayName: name || defaultLiveDisplayName(channel.url),
    enabled: input.enabled, automationId: input.automationId,
    clip: { clippingMode: clip.clippingMode, aspectRatio: clip.aspectRatio, durationRanges: [...clip.durationRanges],
      layoutStyle: clip.layoutStyle, pacing: clip.pacing, includeCaptions: clip.includeCaptions, captionPreset: clip.captionPreset },
    minScore: input.minScore, maxClipsPerChunk: input.maxClipsPerChunk,
    maxPostsPerHour: input.maxPostsPerHour, chunkMinutes: input.chunkMinutes
  }
}

export interface LiveClipCandidate {
  clip_index: number
  start_time_ms: number
  end_time_ms: number
  virality_score: number
}

/** A clip already kept for posting, on the live stream's own timeline. */
export interface KeptLiveClip { start: number; end: number; keptAt: number }

/**
 * Pick the clips of one chunk worth posting. Chunks overlap, so a moment can be
 * found twice: a clip that mostly overlaps one already kept is a duplicate.
 */
export function selectLiveClips(
  clips: readonly LiveClipCandidate[],
  chunk: { streamOffsetSeconds: number },
  kept: readonly KeptLiveClip[],
  options: { minScore: number; maxPostsPerHour: number; now: number }
): { indices: number[]; kept: KeptLiveClip[] } {
  const accepted = [...kept]
  const indices: number[] = []
  const recent = (): number => accepted.filter((item) => options.now - item.keptAt < 3_600_000).length
  for (const clip of [...clips].sort((a, b) => b.virality_score - a.virality_score)) {
    if (!(clip.virality_score >= options.minScore)) continue
    if (recent() >= options.maxPostsPerHour) break
    const start = chunk.streamOffsetSeconds + clip.start_time_ms / 1000
    const end = chunk.streamOffsetSeconds + clip.end_time_ms / 1000
    const length = Math.max(0.001, end - start)
    const duplicate = accepted.some((item) => {
      const overlap = Math.min(end, item.end) - Math.max(start, item.start)
      return overlap > 0.5 * Math.min(length, Math.max(0.001, item.end - item.start))
    })
    if (duplicate) continue
    accepted.push({ start, end, keptAt: options.now })
    indices.push(clip.clip_index)
  }
  return { indices, kept: accepted }
}
