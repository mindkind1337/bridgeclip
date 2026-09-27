import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'fs'
import { open, readdir } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { resolveBinary } from './tools'
import { parseJobOutput, type JobOutput, type RunTranscript } from '../shared/job-output'
import { LIVE_OVERLAP_SECONDS, broadcastTime, chatActivity, clipChatReaction, isLiveTimeline, isReplayUrl, secondsIntoStream, type ChannelLiveSummary, type LiveChannel, type LiveChannelClip, type LivePartInfo, type LiveRunInfo, type LiveTranscript } from '../shared/live'
import { readRunRecord } from './run-history'

export interface JobHistoryEntry {
  jobId: string
  date: string
  videoTitle: string
  clipCount: number
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'interrupted' | 'incomplete'
  outputDir: string
  totalCostUsd: number | null
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
  /** Set for parts of a live recording. */
  live?: LiveRunInfo | null
}

const MAX_JOB_OUTPUT_BYTES = 20 * 1024 * 1024

async function readJobOutput(outputPath: string, libraryDir: string): Promise<{ data: JobOutput; modified: Date } | null> {
  const read = await readLibraryJson(outputPath, libraryDir, MAX_JOB_OUTPUT_BYTES)
  const data = read ? parseJobOutput(read.value) : null
  return data && read ? { data, modified: read.modified } : null
}

/** A JSON file inside the library: a regular file (no links), within the size limit. */
async function readLibraryJson(path: string, libraryDir: string, maxBytes: number): Promise<{ value: unknown; modified: Date } | null> {
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) return null
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.size > maxBytes) return null
    // Windows has no O_NOFOLLOW. Check the name again after opening, then
    // compare it with the file descriptor so a swapped link is not accepted.
    const currentEntry = lstatSync(path)
    if (!currentEntry.isFile() || currentEntry.isSymbolicLink() ||
        file.dev !== currentEntry.dev || file.ino !== currentEntry.ino) return null
    const canonical = realpathSync(path)
    const library = realpathSync(libraryDir)
    const rel = relative(library, canonical)
    const current = statSync(canonical)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ||
        file.dev !== current.dev || file.ino !== current.ino) return null
    return { value: JSON.parse(await handle.readFile('utf-8')), modified: file.mtime }
  } finally {
    await handle.close()
  }
}

const MAX_TRANSCRIPT_BYTES = 30 * 1024 * 1024
const MAX_TRANSCRIPT_LINES = 10_000
const MAX_CHAT_MESSAGES = 20_000

/** A run's transcript and, for live parts, its chat, as plain lines for review in the app. */
export async function getRunTranscript(outputDir: string, libraryDir: string): Promise<RunTranscript | null> {
  let transcript: Awaited<ReturnType<typeof readLibraryJson>> = null
  try { transcript = await readLibraryJson(join(outputDir, 'transcript.json'), libraryDir, MAX_TRANSCRIPT_BYTES) } catch { return null }
  const raw = transcript?.value as { segments?: unknown; language?: unknown } | undefined
  if (!raw || !Array.isArray(raw.segments)) return null
  const lines: RunTranscript['lines'] = []
  for (const segment of raw.segments.slice(0, MAX_TRANSCRIPT_LINES)) {
    const { start_time_ms: start, end_time_ms: end, text, speaker_label: speaker } = (segment ?? {}) as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) continue
    lines.push({ start: start / 1000, end: end / 1000, text: text.slice(0, 2000), speaker: typeof speaker === 'string' ? speaker.slice(0, 16) : null })
  }
  let chat: RunTranscript['chat'] = null
  try {
    const saved = (await readLibraryJson(join(outputDir, 'chat.json'), libraryDir, MAX_TRANSCRIPT_BYTES))?.value as
      { messages?: unknown; truncated?: unknown } | undefined
    if (saved && Array.isArray(saved.messages)) {
      const messages = saved.messages.slice(0, MAX_CHAT_MESSAGES).flatMap((item) => {
        const { t, text } = (item ?? {}) as Record<string, unknown>
        return typeof t === 'number' && Number.isFinite(t) && typeof text === 'string' ? [{ t, text: text.slice(0, 500) }] : []
      })
      chat = { messages, truncated: saved.truncated === true || saved.messages.length > MAX_CHAT_MESSAGES }
    }
  } catch { /* A part without chat.json has no chat to show. */ }
  return { language: typeof raw.language === 'string' ? raw.language.slice(0, 16) : null, lines, chat }
}

export function ensureOutputDir(baseDir: string): void {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
}

export async function getJobHistory(baseDir: string, activeJobIds: ReadonlySet<string> = new Set()): Promise<JobHistoryEntry[]> {
  if (!existsSync(baseDir)) return []

  const entries: JobHistoryEntry[] = []

  try {
    const dirs = (await readdir(baseDir, { withFileTypes: true })).filter((d) => d.isDirectory())

    for (const dir of dirs) {
      const outputPath = join(baseDir, dir.name, 'job_output.json')
      const record = readRunRecord(baseDir, dir.name)
      const durationMs = record?.finishedAt
        ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : null
      try {
        const result = await readJobOutput(outputPath, baseDir)
        if (!result) throw new Error('Unsupported result file')
        const { data } = result
        const costs = data.metrics?.api_costs
        const costVal = costs && typeof costs === 'object' ? (costs as Record<string, unknown>).total_estimated_cost_usd : null
        entries.push({
          jobId: dir.name,
          date: record?.startedAt ?? result.modified.toISOString(),
          videoTitle: data.source_video_title,
          clipCount: data.clips.length,
          status: 'completed',
          outputDir: join(baseDir, dir.name),
          totalCostUsd: typeof costVal === 'number' ? costVal : null,
          finishedAt: record?.finishedAt ?? result.modified.toISOString(),
          durationMs: durationMs ?? (typeof data.processing_time_seconds === 'number' ? Math.round(data.processing_time_seconds * 1000) : null),
          errorMessage: null,
          live: await liveRunInfo(join(baseDir, dir.name), baseDir, data.source_video_title)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Desktop jobs use UUIDs. Keep interrupted runs visible without treating
          // unrelated folders in the selected output directory as clip jobs.
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir.name)) {
            const runDir = join(baseDir, dir.name)
            try {
              const stat = lstatSync(runDir)
              if (stat.isDirectory() && !stat.isSymbolicLink()) {
                const status = record?.status === 'running'
                  ? (activeJobIds.has(dir.name) ? 'running' : 'interrupted')
                  : record?.status === 'failed' || record?.status === 'cancelled'
                    ? record.status : 'incomplete'
                entries.push({ jobId: dir.name, date: record?.startedAt ?? stat.mtime.toISOString(),
                  videoTitle: record?.sourceLabel ?? 'Unfinished run', clipCount: 0,
                  status, outputDir: runDir, totalCostUsd: null,
                  finishedAt: record?.finishedAt ?? null, durationMs,
                  errorMessage: record?.errorMessage ?? null })
              }
            } catch { /* The run directory was removed during the scan. */ }
          }
          continue
        }
        entries.push({ jobId: dir.name, date: record?.startedAt ?? new Date(0).toISOString(), videoTitle: record?.sourceLabel ?? 'Unreadable run', clipCount: 0,
          status: 'failed', outputDir: join(baseDir, dir.name), totalCostUsd: null,
          finishedAt: record?.finishedAt ?? null, durationMs,
          errorMessage: record?.errorMessage ?? 'The saved result could not be read.' })
      }
    }
  } catch {
    throw new Error('Could not read the clip library')
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

export async function getJobOutput(outputDir: string, libraryDir = outputDir): Promise<JobOutput | null> {
  const outputPath = join(outputDir, 'job_output.json')
  try {
    return (await readJobOutput(outputPath, libraryDir))?.data ?? null
  } catch {
    return null
  }
}

async function getVideoDurationSeconds(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    )
    const raw = stdout.trim()
    const dur = parseFloat(raw)
    return Number.isFinite(dur) ? dur : null
  } catch {
    return null
  }
}

/**
 * Generate a thumbnail for a video clip using ffmpeg.
 * Seeks to the middle of the clip for a representative frame.
 * If seekSeconds is provided, uses that instead.
 */
export async function generateThumbnail(videoPath: string, seekSeconds?: number): Promise<string | null> {
  if (!/\.(mp4|m4v|mkv|webm|mov|avi|flv)$/i.test(videoPath)) return null
  if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) return null
  let source: string
  let sourceStat: ReturnType<typeof statSync>
  try {
    source = realpathSync(videoPath)
    sourceStat = statSync(source)
    if (!sourceStat.isFile()) return null
  } catch { return null }

  const thumbnailDir = join(app.getPath('userData'), 'thumbnails')
  mkdirSync(thumbnailDir, { recursive: true, mode: 0o700 })
  if (!lstatSync(thumbnailDir).isDirectory() || lstatSync(thumbnailDir).isSymbolicLink()) return null
  const identity = `${source}:${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeMs}:${seekSeconds ?? 'middle'}`
  const thumbPath = join(thumbnailDir, `${createHash('sha256').update(identity).digest('hex')}.jpg`)
  if (existsSync(thumbPath) && lstatSync(thumbPath).isFile() && !lstatSync(thumbPath).isSymbolicLink()) return thumbPath
  const tempPath = join(thumbnailDir, `${randomUUID()}.jpg`)

  let seekTo = seekSeconds ?? null

  if (seekTo === null) {
    const duration = await getVideoDurationSeconds(source)
    if (duration !== null && duration > 6 * 60 * 60) return null
    if (duration && duration > 0.5) {
      seekTo = Math.min(duration * 0.5, duration - 0.1)
    } else {
      seekTo = 0
    }
  }

  const ffmpeg = resolveBinary('ffmpeg')
  const frameArgs = ['-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-i', source, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=640:-2', tempPath]

  try {
    await execFileAsync(
      ffmpeg,
      seekTo > 0 ? ['-n', '-ss', seekTo.toFixed(2), ...frameArgs] : ['-n', ...frameArgs],
      { timeout: 15000 }
    )
    if (existsSync(tempPath)) {
      renameSync(tempPath, thumbPath)
      return thumbPath
    }
  } catch {
    // Fallback: grab first frame
    try { unlinkSync(tempPath) } catch { /* The first attempt may not have written a frame. */ }
    try {
      await execFileAsync(ffmpeg, ['-n', ...frameArgs], { timeout: 15000 })
      if (existsSync(tempPath)) {
        renameSync(tempPath, thumbPath)
        return thumbPath
      }
    } catch {
      // ignore
    }
  } finally {
    try { unlinkSync(tempPath) } catch { /* No partial thumbnail remains. */ }
  }
  return null
}

const PART_TITLE = /^(.+) live (\d{4}-\d{2}-\d{2} \d{2}[.h]\d{2}) \((?:part|partie) (\d{1,5})\)$/

function livePartInfo(value: unknown): LivePartInfo | null {
  const info = value as LivePartInfo | null
  if (!info || info.version !== 1 || typeof info.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(info.sessionId) ||
      !Number.isInteger(info.part) || info.part < 1 || !Number.isFinite(info.streamOffsetSeconds) || info.streamOffsetSeconds < 0 ||
      !Number.isFinite(info.leadInSeconds) || info.leadInSeconds < 0 || typeof info.channel !== 'string' ||
      !['twitch', 'youtube', 'kick'].includes(info.platform)) return null
  return { ...info, timeline: isLiveTimeline(info.timeline) ? info.timeline : [],
    replayUrl: isReplayUrl(info.replayUrl, info.platform) ? info.replayUrl : null }
}

/** The live session details saved with a clipped part, or null for other runs. */
export async function getLivePartInfo(outputDir: string, libraryDir: string): Promise<LivePartInfo | null> {
  return readPartInfo(outputDir, libraryDir)
}

async function readPartInfo(runDir: string, libraryDir: string): Promise<LivePartInfo | null> {
  try { return livePartInfo((await readLibraryJson(join(runDir, 'live.json'), libraryDir, 64 * 1024))?.value) } catch { return null }
}

type LiveRunMeta = { runDir: string; info: LivePartInfo | null; title: RegExpExecArray | null; duration: number; titleTime: number | null }

async function liveRunMetas(libraryDir: string): Promise<LiveRunMeta[]> {
  const metas: LiveRunMeta[] = []
  for (const entry of await readdir(libraryDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const runDir = join(libraryDir, entry.name)
    const output = await getJobOutput(runDir, libraryDir)
    if (!output) continue
    const info = await readPartInfo(runDir, libraryDir)
    const title = PART_TITLE.exec(output.source_video_title ?? '')
    if (!info && !title) continue
    const parsed = title ? new Date(`${title[2].replace(/[.h]/, ':').replace(' ', 'T')}:00`).getTime() : NaN
    metas.push({ runDir, info, title, duration: Number(output.source_video_duration_seconds) || 0, titleTime: Number.isFinite(parsed) ? parsed : null })
  }
  return metas
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * Join every clipped part of the live this run belongs to. When the broadcast's
 * start is known, that is every part of the broadcast, across app restarts and
 * including older parts of the same channel and day, placed by time into the
 * stream (exact broadcast times for parts with a timeline). Otherwise the parts
 * of one recording session, placed from their offsets. Each part's overlap with
 * the previous part of its session is dropped.
 */
export async function getLiveTranscript(outputDir: string, libraryDir: string): Promise<LiveTranscript | null> {
  const metas = await liveRunMetas(libraryDir)
  const own = metas.find((meta) => resolve(meta.runDir) === resolve(outputDir))
  if (!own) return null
  const channelOf = (meta: LiveRunMeta): string => (meta.title?.[1] ?? meta.info?.channel ?? '').toLowerCase()
  const recordedAt = (meta: LiveRunMeta): number | null =>
    meta.info?.recordingStartedAt ? Date.parse(meta.info.recordingStartedAt) : meta.titleTime
  const sessionOf = (meta: LiveRunMeta): string => meta.info ? `s|${meta.info.sessionId}` : `t|${channelOf(meta)}|${meta.title?.[2]}`
  const channel = channelOf(own)

  let start: number | null = own.info?.streamStartedAt ? Date.parse(own.info.streamStartedAt) : null
  if (start === null) {
    const at = recordedAt(own)
    const starts = metas.flatMap((meta) => meta.info?.streamStartedAt && channelOf(meta) === channel ? [Date.parse(meta.info.streamStartedAt)] : [])
      .filter((time) => at !== null && sameDay(time, at) && time <= at)
    start = starts.length ? Math.max(...starts) : null
  }
  const members = start !== null
    ? metas.filter((meta) => {
      if (channelOf(meta) !== channel) return false
      if (meta.info?.streamStartedAt) return Date.parse(meta.info.streamStartedAt) === start
      const at = recordedAt(meta)
      return at !== null && sameDay(at, start!) && at >= start! - 60_000
    })
    : metas.filter((meta) => sessionOf(meta) === sessionOf(own))

  // Offsets inside each recording session: saved in live.json, or rebuilt from durations and the fixed overlap.
  const placed: { meta: LiveRunMeta; sessionPart: number; offset: number; leadIn: number }[] = []
  const sessions = new Map<string, LiveRunMeta[]>()
  for (const meta of members) sessions.set(sessionOf(meta), [...(sessions.get(sessionOf(meta)) ?? []), meta])
  const missingParts: number[] = []
  for (const runs of sessions.values()) {
    const partOf = (meta: LiveRunMeta): number => meta.info?.part ?? Number(meta.title?.[3] ?? 0)
    runs.sort((a, b) => partOf(a) - partOf(b))
    let offset = 0
    runs.forEach((meta, index) => {
      const part = partOf(meta)
      if (index > 0) for (let missing = partOf(runs[index - 1]) + 1; missing < part; missing++) missingParts.push(missing)
      if (meta.info) {
        placed.push({ meta, sessionPart: part, offset: meta.info.streamOffsetSeconds, leadIn: part > 1 ? meta.info.leadInSeconds : 0 })
        return
      }
      const leadIn = part > 1 ? Math.min(LIVE_OVERLAP_SECONDS, meta.duration / 2) : 0
      if (index > 0) offset += runs[index - 1].duration - leadIn
      placed.push({ meta, sessionPart: part, offset, leadIn })
    })
  }
  const timeAt = (item: typeof placed[number], seconds: number): number => {
    if (start === null) return item.offset + seconds
    const exact = item.meta.info?.timeline?.length ? broadcastTime(item.meta.info.timeline, seconds) : null
    if (exact !== null) return exact - start / 1000
    return ((recordedAt(item.meta) ?? start) - start) / 1000 + item.offset + seconds
  }
  // Parts are numbered by their place in the live.
  placed.sort((a, b) => timeAt(a, a.leadIn) - timeAt(b, b.leadIn))
  const firstRecorded = members.map(recordedAt).filter((time): time is number => time !== null)
  const result: LiveTranscript = {
    channel: own.title?.[1] ?? own.info?.channel ?? channel,
    sessionId: own.info?.sessionId ?? null,
    recordingStartedAt: firstRecorded.length ? new Date(Math.min(...firstRecorded)).toISOString() : null,
    streamStartedAt: start !== null ? new Date(start).toISOString() : null,
    timeBase: start !== null ? 'stream' : 'recording',
    parts: [], missingParts: sessions.size === 1 ? missingParts : [], lines: [], chat: []
  }
  for (const [index, item] of placed.entries()) {
    const part = index + 1
    const transcript = await getRunTranscript(item.meta.runDir, libraryDir)
    const info = item.meta.info
    result.parts.push({ part, runDir: item.meta.runDir, hasTranscript: Boolean(transcript),
      hasReplay: Boolean(info?.replayUrl && info.timeline?.length && info.streamStartedAt) })
    for (const line of transcript?.lines ?? []) {
      if (line.start < item.leadIn) continue
      result.lines.push({ t: timeAt(item, line.start), part, partSeconds: line.start, text: line.text, speaker: line.speaker })
    }
    for (const message of transcript?.chat?.messages ?? []) {
      if (message.t >= item.leadIn) result.chat.push({ t: timeAt(item, message.t), text: message.text })
    }
  }
  result.lines.sort((a, b) => a.t - b.t)
  result.chat.sort((a, b) => a.t - b.t)
  return result.parts.length ? result : null
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/** Plain text of a live transcript: time into the stream when its start is known, else recording time. */
export function liveTranscriptText(transcript: LiveTranscript): string {
  const stream = transcript.streamStartedAt ? Date.parse(transcript.streamStartedAt) : NaN
  const recording = transcript.recordingStartedAt ? Date.parse(transcript.recordingStartedAt) : NaN
  const header = [
    `${transcript.channel} — live transcript`,
    Number.isFinite(stream) ? `Stream started: ${new Date(stream).toLocaleString()}` : null,
    Number.isFinite(recording) ? `Recording started: ${new Date(recording).toLocaleString()}` : null,
    `Parts: ${transcript.parts.length}${transcript.missingParts.length ? ` (missing: ${transcript.missingParts.join(', ')})` : ''}`,
    transcript.timeBase === 'stream' ? 'Times: time into the stream. Moments before the recording started are not included.'
      : 'Times: recording time. Skipped ads are not counted.',
    ''
  ].filter((line): line is string => line !== null)
  const body = transcript.lines.map((line) => `[${clock(line.t)}] ${line.speaker ? `(${line.speaker}) ` : ''}${line.text}`)
  return [...header, ...body].join('\n') + '\n'
}

const MAX_CHANNEL_CLIPS = 60

/**
 * Clips of one of a channel's lives: the broadcast being recorded (when its
 * start is given), otherwise the channel's latest live in the library. Parts
 * are recognised by their live.json, or for older parts, by their title; parts
 * without a broadcast start join the broadcast of the same day that began
 * before them, or form one live per day.
 */
export async function getChannelClips(channel: Pick<LiveChannel, 'id' | 'url' | 'displayName'>, currentStreamStart: number | null,
  libraryDir: string): Promise<{ clips: LiveChannelClip[]; parts: number; live: ChannelLiveSummary | null }> {
  const names = new Set([channel.displayName, channel.url.replace(/\/+$/, '').split('/').pop() ?? '']
    .map((name) => name.replace(/^@/, '').toLowerCase()).filter(Boolean))
  let entries: import('fs').Dirent[]
  try { entries = await readdir(libraryDir, { withFileTypes: true }) } catch { return { clips: [], parts: 0, live: null } }
  type Found = { runDir: string; info: LivePartInfo | null; output: JobOutput; modified: number; recordedAt: number; part: number; end: number }
  const found: Found[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const runDir = join(libraryDir, entry.name)
    const info = await readPartInfo(runDir, libraryDir)
    if (info && info.channelId !== channel.id) continue
    const read = await readJobOutput(join(runDir, 'job_output.json'), libraryDir).catch(() => null)
    if (!read) continue
    const title = PART_TITLE.exec(read.data.source_video_title ?? '')
    if (!info && !(title && names.has(title[1].toLowerCase()))) continue
    const titleTime = title ? new Date(`${title[2].replace(/[.h]/, ':').replace(' ', 'T')}:00`).getTime() : NaN
    const recordedAt = info?.recordingStartedAt ? Date.parse(info.recordingStartedAt) : Number.isFinite(titleTime) ? titleTime : read.modified.getTime()
    const lastSpan = info?.timeline?.[info.timeline.length - 1]
    found.push({ runDir, info, output: read.data, modified: read.modified.getTime(), recordedAt,
      part: info?.part ?? Number(title?.[3] ?? 0),
      // The part's end: exact from its last broadcast span, else when it finished clipping.
      end: lastSpan ? (lastSpan[1] + lastSpan[2]) * 1000 : read.modified.getTime() })
  }
  const startOf = (item: Found): number | null => item.info?.streamStartedAt ? Date.parse(item.info.streamStartedAt) : null
  const day = (time: number): string => new Date(time).toDateString()
  const starts = [...new Set(found.map(startOf).filter((time): time is number => time !== null))]
  const keyOf = (item: Found): string => {
    const own = startOf(item)
    if (own !== null) return `s${own}`
    const match = starts.filter((time) => day(time) === day(item.recordedAt) && time <= item.recordedAt).sort((a, b) => b - a)[0]
    return match !== undefined ? `s${match}` : `d${day(item.recordedAt)}`
  }
  const groups = new Map<string, Found[]>()
  for (const item of found) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  const chosenKey = currentStreamStart !== null && Number.isFinite(currentStreamStart) ? `s${currentStreamStart}`
    : [...groups.entries()].sort((a, b) => Math.max(...b[1].map((item) => item.end)) - Math.max(...a[1].map((item) => item.end)))[0]?.[0]
  const members = (chosenKey && groups.get(chosenKey)) || []
  const clips: LiveChannelClip[] = []
  for (const item of members) {
    const chat = chatActivity(await readRunChat(item.runDir, libraryDir))
    for (const clip of item.output.clips) {
      const path = clip.s3_url.startsWith('file://') ? clip.s3_url.slice('file://'.length) : clip.s3_url
      const inside = relative(item.runDir, path)
      if (!inside || isAbsolute(inside) || inside.startsWith('..')) continue
      const startSeconds = clip.start_time_ms / 1000
      clips.push({
        runDir: item.runDir, clipPath: path, clipIndex: clip.clip_index, title: clip.summary || `Clip ${clip.clip_index + 1}`,
        score: clip.virality_score, part: item.part, startSeconds, durationMs: clip.duration_ms,
        intoStream: item.info ? secondsIntoStream(item.info, startSeconds) : null,
        hasReplay: Boolean(item.info?.replayUrl && item.info.timeline?.length && item.info.streamStartedAt),
        recordedAt: new Date(item.modified).toISOString(),
        chatReaction: chatReactionOf(clipChatReaction(chat, startSeconds, clip.end_time_ms / 1000))
      })
    }
  }
  clips.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.score - a.score)
  const streamStart = chosenKey?.startsWith('s') ? Number(chosenKey.slice(1)) : null
  const live: ChannelLiveSummary | null = members.length ? {
    streamStartedAt: streamStart !== null ? new Date(streamStart).toISOString() : null,
    firstRecordedAt: new Date(Math.min(...members.map((item) => item.recordedAt))).toISOString(),
    lastRecordedAt: new Date(Math.max(...members.map((item) => item.end))).toISOString()
  } : null
  return { clips: clips.slice(0, MAX_CHANNEL_CLIPS), parts: members.length, live }
}

/** Live details for the library list: from live.json, or parsed from a part's title for older parts. */
async function liveRunInfo(runDir: string, libraryDir: string, title: string): Promise<LiveRunInfo | null> {
  const info = await readPartInfo(runDir, libraryDir)
  const match = PART_TITLE.exec(title ?? '')
  const fromTitle = match ? new Date(`${match[2].replace(/[.h]/, ':').replace(' ', 'T')}:00`) : null
  if (info) {
    const recordedAt = info.recordingStartedAt ?? (fromTitle && !Number.isNaN(fromTitle.getTime()) ? fromTitle.toISOString() : null)
    return { channel: match?.[1] ?? info.channel, platform: info.platform, part: info.part, streamStartedAt: info.streamStartedAt,
      recordedAt: recordedAt ?? new Date(0).toISOString() }
  }
  if (!match || !fromTitle || Number.isNaN(fromTitle.getTime())) return null
  return { channel: match[1], platform: null, part: Number(match[3]), streamStartedAt: null, recordedAt: fromTitle.toISOString() }
}

/** A part's saved chat messages (chat.json), or none. */
async function readRunChat(runDir: string, libraryDir: string): Promise<{ t: number; text: string }[]> {
  try {
    const saved = (await readLibraryJson(join(runDir, 'chat.json'), libraryDir, 30 * 1024 * 1024))?.value as { messages?: unknown } | undefined
    if (!saved || !Array.isArray(saved.messages)) return []
    return saved.messages.flatMap((item) => {
      const { t, text } = (item ?? {}) as Record<string, unknown>
      return typeof t === 'number' && Number.isFinite(t) && typeof text === 'string' ? [{ t, text }] : []
    })
  } catch { return [] }
}

function chatReactionOf(found: { count: number; ratio: number; reaction: string | null } | null): LiveChannelClip['chatReaction'] {
  return found ? { count: found.count, ratio: found.ratio, reaction: found.reaction } : null
}

const MAX_LIVE_RUNS = 200

/**
 * Every clip of the given runs (the parts of one live, in order), with the
 * part's place in the live, time into the stream, replay availability and the
 * chat spike each clip caused. Runs outside the library are skipped.
 */
export async function getRunsClips(runDirs: unknown, libraryDir: string): Promise<LiveChannelClip[]> {
  if (!Array.isArray(runDirs)) return []
  const clips: LiveChannelClip[] = []
  for (const [index, runDir] of runDirs.slice(0, MAX_LIVE_RUNS).entries()) {
    if (typeof runDir !== 'string' || !isAbsolute(runDir)) continue
    const inside = relative(resolve(libraryDir), resolve(runDir))
    if (!inside || isAbsolute(inside) || inside.startsWith('..')) continue
    const read = await readJobOutput(join(runDir, 'job_output.json'), libraryDir).catch(() => null)
    if (!read) continue
    const info = await readPartInfo(runDir, libraryDir)
    const chat = chatActivity(await readRunChat(runDir, libraryDir))
    for (const clip of read.data.clips) {
      const path = clip.s3_url.startsWith('file://') ? clip.s3_url.slice('file://'.length) : clip.s3_url
      const within = relative(runDir, path)
      if (!within || isAbsolute(within) || within.startsWith('..')) continue
      const startSeconds = clip.start_time_ms / 1000
      clips.push({
        runDir, clipPath: path, clipIndex: clip.clip_index, title: clip.summary || `Clip ${clip.clip_index + 1}`,
        score: clip.virality_score, part: index + 1, startSeconds, durationMs: clip.duration_ms,
        intoStream: info ? secondsIntoStream(info, startSeconds) : null,
        hasReplay: Boolean(info?.replayUrl && info.timeline?.length && info.streamStartedAt),
        recordedAt: read.modified.toISOString(),
        chatReaction: chatReactionOf(clipChatReaction(chat, startSeconds, clip.end_time_ms / 1000))
      })
    }
  }
  return clips
}
