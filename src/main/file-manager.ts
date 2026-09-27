import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'fs'
import { open, readdir } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { resolveBinary } from './tools'
import { parseJobOutput, type JobOutput, type RunTranscript } from '../shared/job-output'
import { LIVE_OVERLAP_SECONDS, isLiveTimeline, isReplayUrl, type LivePartInfo, type LiveTranscript } from '../shared/live'
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
          errorMessage: null
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

/**
 * Join every clipped part of the live session this run belongs to: parts are
 * found through live.json, or for parts recorded before it existed, through
 * their "channel live date (part N)" title, durations and the fixed overlap.
 * Each part's overlap with the previous one is dropped.
 */
export async function getLiveTranscript(outputDir: string, libraryDir: string): Promise<LiveTranscript | null> {
  const own = await readPartInfo(outputDir, libraryDir)
  const dirs = (await readdir(libraryDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(libraryDir, entry.name))
  type Part = { part: number; runDir: string; offset: number; leadIn: number; hasReplay?: boolean }
  let parts: Part[] = []
  let meta: Pick<LiveTranscript, 'channel' | 'sessionId' | 'recordingStartedAt' | 'streamStartedAt'>
  if (own) {
    meta = { channel: own.channel, sessionId: own.sessionId, recordingStartedAt: own.recordingStartedAt, streamStartedAt: own.streamStartedAt }
    for (const dir of dirs) {
      const info = dir === outputDir ? own : await readPartInfo(dir, libraryDir)
      if (info?.sessionId === own.sessionId) {
        parts.push({ part: info.part, runDir: dir, offset: info.streamOffsetSeconds, leadIn: info.part > 1 ? info.leadInSeconds : 0,
          hasReplay: Boolean(info.replayUrl && info.timeline?.length && info.streamStartedAt) })
      }
    }
  } else {
    const title = (await getJobOutput(outputDir, libraryDir))?.source_video_title ?? ''
    const match = PART_TITLE.exec(title)
    if (!match) return null
    const found: { part: number; runDir: string; duration: number }[] = []
    for (const dir of dirs) {
      const output = dir === outputDir || (await readPartInfo(dir, libraryDir)) === null ? await getJobOutput(dir, libraryDir) : null
      const other = output ? PART_TITLE.exec(output.source_video_title ?? '') : null
      if (other && other[1] === match[1] && other[2] === match[2]) {
        found.push({ part: Number(other[3]), runDir: dir, duration: Number(output?.source_video_duration_seconds) || 0 })
      }
    }
    found.sort((a, b) => a.part - b.part)
    let offset = 0
    parts = found.map((item, index) => {
      const leadIn = item.part > 1 ? Math.min(LIVE_OVERLAP_SECONDS, item.duration / 2) : 0
      if (index > 0) offset = parts[index - 1].offset + found[index - 1].duration - leadIn
      const entry = { part: item.part, runDir: item.runDir, offset, leadIn }
      parts[index] = entry
      return entry
    })
    meta = { channel: match[1], sessionId: null, recordingStartedAt: null, streamStartedAt: null }
  }
  parts.sort((a, b) => a.part - b.part)
  const result: LiveTranscript = { ...meta, parts: [], missingParts: [], lines: [], chat: [] }
  for (const [index, part] of parts.entries()) {
    if (index > 0) for (let missing = parts[index - 1].part + 1; missing < part.part; missing++) result.missingParts.push(missing)
    const transcript = await getRunTranscript(part.runDir, libraryDir)
    result.parts.push({ part: part.part, runDir: part.runDir, hasTranscript: Boolean(transcript), hasReplay: part.hasReplay === true })
    for (const line of transcript?.lines ?? []) {
      if (line.start < part.leadIn) continue
      result.lines.push({ t: part.offset + line.start, part: part.part, partSeconds: line.start, text: line.text, speaker: line.speaker })
    }
    for (const message of transcript?.chat?.messages ?? []) {
      if (message.t >= part.leadIn) result.chat.push({ t: part.offset + message.t, text: message.text })
    }
  }
  return result.parts.length ? result : null
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/** Plain text of a live transcript, with recording time and, when known, time into the stream. */
export function liveTranscriptText(transcript: LiveTranscript): string {
  const recording = transcript.recordingStartedAt ? Date.parse(transcript.recordingStartedAt) : NaN
  const stream = transcript.streamStartedAt ? Date.parse(transcript.streamStartedAt) : NaN
  const into = Number.isFinite(recording) && Number.isFinite(stream) ? (recording - stream) / 1000 : null
  const header = [
    `${transcript.channel} — live transcript`,
    transcript.streamStartedAt ? `Stream started: ${new Date(stream).toLocaleString()}` : null,
    transcript.recordingStartedAt ? `Recording started: ${new Date(recording).toLocaleString()}` : null,
    `Parts: ${transcript.parts.map((part) => part.part).join(', ')}${transcript.missingParts.length ? ` (missing: ${transcript.missingParts.join(', ')})` : ''}`,
    'Times: recording time' + (into !== null ? ' / time into the stream' : '') + '. Skipped ads are not counted.',
    ''
  ].filter((line): line is string => line !== null)
  const body = transcript.lines.map((line) =>
    `[${clock(line.t)}${into !== null ? ` / ${clock(line.t + into)}` : ''}] ${line.speaker ? `(${line.speaker}) ` : ''}${line.text}`)
  return [...header, ...body].join('\n') + '\n'
}
