import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BRIDGE_CONTRACT_VERSION } from '../../shared/job-contract'
import { MAX_LIVE_ACTIVITY, liveOverlapSeconds, selectLiveClips, type KeptLiveClip, type LiveActivityTone, type LiveChannel, type LiveClipDecision, type LiveNetwork, type LivePartInfo, type LiveSessionState, isLiveTimeline, isReplayUrl } from '../../shared/live'
import { addLibraryClipsToAutomation } from '../automations'
import { getJobOutput } from '../file-manager'
import { logger } from '../logger'
import {
  boundedBridgeLines, bridgeSpawnEnvironment, getBridgeRunnerPath, getEnginePath, openDevEngineLog,
  preflightCheck, resolvePythonPath, terminateProcessTree, workRoot
} from '../pipeline-runner'
import { createRunRecord, finishRunRecord } from '../run-history'
import { loadSettings, vocabularyTerms } from '../settings-store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIVE_OUTPUT_BYTES = 64 * 1024 * 1024
const FORCE_STOP_MS = 15 * 60 * 1000

/** Clips kept per channel for this app session, so restarts of a stream do not repost moments. */
const keptByChannel = new Map<string, KeptLiveClip[]>()
const activeChunkJobs = new Set<string>()

/** Chunk runs still being clipped; the library shows them as running, not interrupted. */
export function activeLiveJobIds(): ReadonlySet<string> { return new Set(activeChunkJobs) }

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value || value.length > 300 || /https?:\/\/|[\\/]|(?:token|secret|key)\s*[:=]/i.test(value)) return fallback
  return value
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

/** Engine step text for the activity log: plain words and counts like "1 of 2" only. */
function safeStep(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 ||
      /https?:|:\/\/|\\|(?:^|\s)\/|[A-Za-z]:[\\/]|(?:token|secret|key)\s*[:=]/i.test(value)) return null
  return value.trim()
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const hours = Math.floor(whole / 3600)
  const rest = `${String(Math.floor((whole % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(whole % 60).padStart(2, '0')}`
  return hours ? `${hours}:${rest}` : rest
}

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`
}

const HOUR_MINUTE = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
/** A stream start within this of the recording start counts as recording from the beginning. */
const FROM_START_SECONDS = 120

const DECISION_TEXT: Record<LiveClipDecision, (minScore: number, linked: boolean) => string> = {
  kept: (_min, linked) => linked ? 'queued for posting' : 'kept (no automation linked)',
  low_score: (min) => `not posted: score below ${Math.round(min * 100)}`,
  duplicate: () => 'not posted: same moment as a clip already kept',
  hourly_limit: () => 'not posted: hourly posting limit reached',
  boundary: () => 'not posted: cut by the end of the part (the next part has this moment whole)'
}

interface ChunkPlacement {
  jobId: string; part: number; streamOffsetSeconds: number; leadInSeconds: number; timeline: [number, number, number][]
  durationSeconds: number | null; final: boolean
}

function placement(message: Record<string, unknown>): ChunkPlacement | null {
  const { job_id: jobId, part, stream_offset_s: offset } = message
  if (typeof jobId !== 'string' || !UUID.test(jobId) || !Number.isInteger(part) || (part as number) < 1 || !finite(offset) || offset < 0) return null
  const leadIn = message.lead_in_s
  return { jobId, part: part as number, streamOffsetSeconds: offset, leadInSeconds: finite(leadIn) && leadIn >= 0 ? leadIn : 0,
    timeline: isLiveTimeline(message.timeline) ? message.timeline : [],
    durationSeconds: finite(message.duration_s) && message.duration_s > 0 ? message.duration_s : null, final: message.final === true }
}

export class LiveSession {
  readonly sessionId = randomUUID()
  readonly state: LiveSessionState
  private child: ChildProcess | null = null
  private stopping = false
  private queue: Promise<void> = Promise.resolve()
  /** This session's parts that started clipping but have not finished. */
  private readonly openJobs = new Set<string>()
  private readonly outputDirectory: string

  constructor(private readonly channel: LiveChannel, private readonly onChange: (state: LiveSessionState) => void,
    private readonly onExit: () => void) {
    this.outputDirectory = loadSettings().outputDirectory
    this.state = {
      channelId: channel.id, status: 'resolving', partsDone: 0, processingPart: null, clipsMade: 0, clipsQueued: 0, recording: null,
      clipping: null, activity: [], startedAt: new Date().toISOString(), endedAt: null, message: null
    }
  }

  start(): void {
    const settings = loadSettings()
    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath('live_runner.py')
    const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)
    const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
    if (!preflight.ok) return this.finish('error', preflight.hint ?? 'The live engine is not installed correctly.')
    let env: Record<string, string | undefined>
    try { env = bridgeSpawnEnvironment(settings, enginePath, workRoot()) }
    catch { return this.finish('error', 'BridgeClip could not create a private temporary work folder.') }
    const { clip } = this.channel
    const spec = JSON.stringify({
      contract_version: BRIDGE_CONTRACT_VERSION,
      mode: 'record',
      session_id: this.sessionId,
      // The engine quits by itself if BridgeClip disappears without stopping it.
      parent_pid: process.pid,
      channel_url: this.channel.url,
      chunk_seconds: this.channel.chunkMinutes * 60,
      overlap_seconds: liveOverlapSeconds(this.channel.clip.durationRanges, this.channel.chunkMinutes),
      max_clips_per_chunk: this.channel.maxClipsPerChunk,
      chat_priority: this.channel.chatPriority === true,
      clip: {
        clipping_mode: clip.clippingMode,
        layout_vision_enabled: clip.clippingMode !== 'economy',
        aspect_ratio: clip.aspectRatio,
        duration_ranges: clip.durationRanges,
        layout_style: clip.layoutStyle,
        pacing: clip.pacing,
        video_speed: 1,
        include_captions: clip.includeCaptions,
        caption_preset: clip.captionPreset,
        keyterms: vocabularyTerms(settings.customVocabulary),
        output_dir: this.outputDirectory
      }
    })
    let child: ChildProcess
    try {
      child = spawn(pythonPath, [bridgePath], {
        cwd: enginePath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
      })
    } catch {
      return this.finish('error', 'Failed to start the live engine.')
    }
    this.child = child
    this.log('Opening the stream')
    logger.info('live.session.start', { sessionId: this.sessionId, channelId: this.channel.id, platform: this.channel.platform, pid: child.pid })
    child.stdin?.on('error', () => { /* Close reports failures. */ })
    // stdin carries only the spec: a Python thread blocked reading a pipe can stall the engine on Windows.
    child.stdin?.end(`${spec}\n`)
    const engineLog = openDevEngineLog(`live-${this.sessionId}`)
    child.stderr?.on('data', (data: Buffer) => engineLog.write(data))
    if (child.stdout) {
      boundedBridgeLines(child.stdout, MAX_LIVE_OUTPUT_BYTES, () => {
        logger.error('live.session.outputLimit', { sessionId: this.sessionId })
        this.update({ message: 'The live engine produced too much output and was stopped.' })
        terminateProcessTree(child, true)
      }).on('line', (line) => this.onLine(line))
    }
    child.on('error', () => this.update({ status: 'error', message: 'Failed to start the live engine.' }))
    child.on('close', (code) => {
      engineLog.close()
      this.child = null
      logger.info('live.session.close', { sessionId: this.sessionId, code })
      void this.queue.then(() => {
        if (this.state.status !== 'ended' && this.state.status !== 'error') {
          this.finish(this.stopping ? 'ended' : 'error', this.stopping ? this.state.message : 'The live engine stopped unexpectedly.')
        } else this.finish(this.state.status, this.state.message)
      })
    })
  }

  /** Finish the part being recorded, clip it, then exit. A second call ends at once. */
  stop(): void {
    if (!this.child) return
    if (this.stopping) { terminateProcessTree(this.child, true); return }
    this.stopping = true
    this.log('Stopping: finishing and clipping the part being recorded')
    this.update({ status: 'stopping' })
    try {
      const sessionWork = join(workRoot(), `live-${this.sessionId}`)
      mkdirSync(sessionWork, { recursive: true, mode: 0o700 })
      writeFileSync(join(sessionWork, 'stop'), '', { mode: 0o600 })
    } catch {
      // Without the stop file the engine cannot finish cleanly; end it now.
      terminateProcessTree(this.child, true)
      return
    }
    const child = this.child
    setTimeout(() => { if (this.child === child) terminateProcessTree(child, true) }, FORCE_STOP_MS).unref()
  }

  /** App quit: no time to finish the current part. */
  kill(): number | undefined {
    const pid = this.child?.pid
    if (this.child) terminateProcessTree(this.child, true)
    return pid
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      message = parsed as Record<string, unknown>
    } catch { return }
    switch (message.type) {
      case 'status':
        if (message.status === 'recording' && !this.stopping) {
          if (this.state.status !== 'recording') {
            const now = Date.now()
            const started = finite(message.stream_started_at) && message.stream_started_at * 1000 <= now + 300_000
              ? message.stream_started_at * 1000 : null
            const behind = started === null ? null : Math.max(0, (now - started) / 1000)
            this.log(behind === null ? 'Live found: recording started (the platform did not say when the stream began)'
              : behind <= FROM_START_SECONDS ? 'Live found: recording from the start of the stream'
                : `Live since ${HOUR_MINUTE.format(started!)} (${duration(behind)} ago): recording from now on, the first ${duration(behind)} are not recorded`)
            this.update({ status: 'recording', recordingStartedAt: new Date(now).toISOString(),
              streamStartedAt: started === null ? null : new Date(started).toISOString() })
          } else this.update({ status: 'recording' })
        }
        break
      case 'progress': {
        const { part, recorded_s: seconds, part_s: target, gaps, ads } = message
        if (Number.isInteger(part) && (part as number) >= 1 && finite(seconds) && seconds >= 0 && finite(target) && target > 0 &&
            Number.isInteger(gaps) && (gaps as number) >= 0 && Number.isInteger(ads) && (ads as number) >= 0) {
          const previous = this.state.recording
          const adsNow = ads as number
          const gapsNow = gaps as number
          // One line per ad break (ads start rising again), not per skipped segment.
          if (adsNow > (previous?.ads ?? 0) && !this.inAdBreak) {
            this.inAdBreak = true
            this.log('Twitch ad break: the stream is not sent during ads, so this time is skipped', 'warn')
          } else if (adsNow === (previous?.ads ?? 0) && this.inAdBreak) {
            this.inAdBreak = false
            this.log('Ad break over: recording the stream again')
          }
          const network = liveNetwork(message.network)
          if (network?.slow && !this.slowNetwork) {
            this.slowNetwork = true
            this.log(`Internet too slow for this stream: ${network.mbps} Mb/s received, the stream needs about ${network.neededMbps} Mb/s. Parts of the live are lost`, 'warn')
          } else if (network && !network.slow && this.slowNetwork) {
            this.slowNetwork = false
            this.log('Connection keeps up with the stream again')
          }
          if (gapsNow > (previous?.gaps ?? 0)) {
            const lost = gapsNow - (previous?.gaps ?? 0)
            this.log(`${lost} stream segment(s) could not be downloaded and were lost${network?.slow ? ' (connection too slow)' : ''}`, 'warn')
          }
          this.update({ recording: { part: part as number, seconds, targetSeconds: target, gaps: gapsNow, ads: adsNow,
            ...(network ? { network } : {}) } })
        }
        break
      }
      case 'chunk_started': {
        const chunk = placement(message)
        if (!chunk) break
        activeChunkJobs.add(chunk.jobId)
        this.openJobs.add(chunk.jobId)
        try { createRunRecord(this.outputDirectory, chunk.jobId, this.channel.url) }
        catch { logger.warn('live.history.writeFailed', { sessionId: this.sessionId }) }
        const length = finite(message.duration_s) ? message.duration_s : null
        const leadIn = finite(message.lead_in_s) ? message.lead_in_s : 0
        // Where the part sits in the broadcast: approximate, since skipped ads are not counted.
        const into = this.state.streamStartedAt && this.state.recordingStartedAt
          ? (Date.parse(this.state.recordingStartedAt) - Date.parse(this.state.streamStartedAt)) / 1000 + chunk.streamOffsetSeconds : null
        const span = into !== null && length ? ` · about ${clock(into)} → ${clock(into + length)} into the stream` : ''
        this.log(`Part ${chunk.part} recorded${length ? ` (${clock(length - leadIn)}${leadIn ? `, plus ${clock(leadIn)} overlap` : ''})` : ''}${span}: clipping it now`)
        this.update({ processingPart: chunk.part, clipping: { part: chunk.part, step: 'Starting', percent: 0 } })
        break
      }
      case 'chat':
        if (message.state === 'connected' && !this.chatConnected) {
          this.chatConnected = true
          this.log(`Reading the ${this.channel.platform === 'kick' ? 'Kick' : 'Twitch'} chat: reactions will help pick the moments`)
        } else if (message.state === 'reconnecting' && this.chatConnected) {
          this.chatConnected = false
          this.log('Chat connection lost: reconnecting', 'warn')
        }
        this.update({})
        break
      case 'chat_summary': {
        const part = message.part
        if (!Number.isInteger(part)) break
        const count = Number.isInteger(message.messages) ? message.messages as number : 0
        if (message.timing === false) {
          this.log(`Part ${part}: chat not used (the platform did not time this part's video)`, 'warn')
        } else if (!count) {
          this.log(`Part ${part}: no chat messages during this part`)
        } else {
          const peak = finite(message.peak_s) && Number.isInteger(message.peak_count)
            ? ` · biggest reaction at ${clock(message.peak_s)} (${message.peak_count} messages${
              typeof message.peak_reaction === 'string' && /^[\p{L}\p{N}\p{Emoji}]{1,24}$/u.test(message.peak_reaction) ? `, ${message.peak_reaction}` : ''})`
            : ''
          this.log(`Part ${part}: ${count.toLocaleString('en-US')} chat messages${peak} · sent to the AI with the transcript`)
        }
        this.update({})
        break
      }
      case 'replay':
        if (isReplayUrl(message.url, this.channel.platform) && message.url !== this.state.replayUrl) {
          this.log(`Replay found: ${message.url.replace(/^https:\/\/(www\.)?/, '')} (clips link to their moment in it)`, 'good')
          this.update({ replayUrl: message.url })
          // Parts saved before the replay was known get it too.
          for (const [runDirectory, chunk] of this.savedParts) this.savePartInfo(runDirectory, chunk)
        }
        break
      case 'chat_priority':
        if (Number.isInteger(message.part) && finite(message.at_s)) {
          this.log(`Part ${message.part}: chat priority — the biggest laugh is at ${clock(message.at_s)}, a clip will include it`)
          this.update({})
        }
        break
      case 'chunk_progress': {
        const step = safeStep(message.step)
        const part = message.part
        if (!step || !Number.isInteger(part) || part !== this.state.processingPart) break
        // "Downloading" is the engine reading the local recording; completion is logged with the clips.
        if (/^Downloading/i.test(step)) break
        const percent = finite(message.percent) ? Math.min(100, Math.max(0, message.percent)) : this.state.clipping?.percent ?? 0
        if (!/^(Processing complete|Clips saved)/i.test(step)) this.log(`Part ${part}: ${step.replace(/\.\.\.$/, '')}`)
        this.update({ clipping: { part: part as number, step, percent } })
        break
      }
      case 'chunk_done': {
        const chunk = placement(message)
        if (chunk) this.enqueue(() => this.chunkDone(chunk))
        break
      }
      case 'chunk_failed': {
        const chunk = placement(message)
        const text = safeText(message.message, 'This part could not be clipped.')
        this.enqueue(async () => {
          if (chunk) {
            activeChunkJobs.delete(chunk.jobId)
            this.openJobs.delete(chunk.jobId)
            try { finishRunRecord(this.outputDirectory, chunk.jobId, 'failed', text) } catch { /* Best effort. */ }
          }
          this.log(`Part ${chunk?.part ?? message.part ?? '?'}: ${text}`, 'warn')
          this.update({ partsDone: this.state.partsDone + 1, processingPart: null, clipping: null, message: text })
        })
        break
      }
      case 'stream_ended':
        this.enqueue(async () => {
          this.log(message.reason === 'offline' ? 'The channel is not live right now' : message.reason === 'stopped'
            ? 'Recording stopped' : message.reason === 'limit' ? 'Stopped after 12 hours of recording' : 'The stream ended')
          this.update({ status: 'ended', message: message.reason === 'limit'
            ? 'Stopped after 12 hours of recording.' : message.reason === 'offline' ? 'The channel is not live right now.' : null })
        })
        break
      case 'error': {
        const text = safeText(message.message, 'Live recording failed.')
        const hint = message.hint ? safeText(message.hint, '') : ''
        this.enqueue(async () => {
          this.log(text, 'warn')
          this.update({ status: 'error', message: hint ? `${text} ${hint}` : text })
        })
        break
      }
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => { logger.warn('live.session.taskFailed', { sessionId: this.sessionId }) })
  }

  private async chunkDone(chunk: ChunkPlacement): Promise<void> {
    activeChunkJobs.delete(chunk.jobId)
    this.openJobs.delete(chunk.jobId)
    try { finishRunRecord(this.outputDirectory, chunk.jobId, 'completed') } catch { /* Best effort. */ }
    const runDirectory = join(this.outputDirectory, chunk.jobId)
    const output = await getJobOutput(runDirectory, this.outputDirectory)
    if (!output) {
      this.log(`Part ${chunk.part}: the clipped part could not be read from the library`, 'warn')
      this.update({ partsDone: this.state.partsDone + 1, processingPart: null, clipping: null, message: 'A clipped part could not be read from the library.' })
      return
    }
    this.savePartInfo(runDirectory, chunk)
    const kept = keptByChannel.get(this.channel.id) ?? []
    const selection = selectLiveClips(output.clips, chunk, kept, {
      minScore: this.channel.minScore, maxPostsPerHour: this.channel.maxPostsPerHour, now: Date.now()
    })
    let queued = 0
    let message: string | null = null
    if (this.channel.automationId && selection.indices.length) {
      try {
        await addLibraryClipsToAutomation(this.channel.automationId, runDirectory, selection.indices)
        queued = selection.indices.length
        keptByChannel.set(this.channel.id, selection.kept.slice(-200))
      } catch (error) {
        message = `Clips were saved to the library but not queued: ${safeText(error instanceof Error ? error.message : '', 'the automation is unavailable.')}`
      }
    } else if (!this.channel.automationId) {
      keptByChannel.set(this.channel.id, selection.kept.slice(-200))
    }
    logger.info('live.chunk.done', { sessionId: this.sessionId, part: chunk.part, clips: output.clips.length, queued })
    this.log(`Part ${chunk.part}: ${output.clips.length} clip${output.clips.length === 1 ? '' : 's'} made`, 'good')
    const linked = Boolean(this.channel.automationId) && !message
    for (const { clip, decision } of selection.decisions) {
      const title = (clip.summary || `Clip ${clip.clip_index + 1}`).replace(/\s+/g, ' ').slice(0, 80)
      this.log(`“${title}” · score ${Math.round(clip.virality_score * 100)} · ${DECISION_TEXT[decision](this.channel.minScore, linked)}`,
        decision === 'kept' ? 'good' : 'info')
    }
    if (message) this.log(message, 'warn')
    this.update({
      clipping: null,
      partsDone: this.state.partsDone + 1, processingPart: null, clipsMade: this.state.clipsMade + output.clips.length,
      clipsQueued: this.state.clipsQueued + queued, message
    })
  }

  private readonly savedParts = new Map<string, ChunkPlacement>()

  /** Lets the library join this session's parts into one transcript and link clips to the replay. */
  private savePartInfo(runDirectory: string, chunk: ChunkPlacement): void {
    this.savedParts.set(runDirectory, chunk)
    const info: LivePartInfo = {
      version: 1, sessionId: this.sessionId, channelId: this.channel.id, channel: this.channel.displayName,
      platform: this.channel.platform, part: chunk.part, streamOffsetSeconds: chunk.streamOffsetSeconds,
      leadInSeconds: chunk.leadInSeconds, recordingStartedAt: this.state.recordingStartedAt ?? null,
      streamStartedAt: this.state.streamStartedAt ?? null,
      timeline: chunk.timeline, replayUrl: this.state.replayUrl ?? null
    }
    const temp = join(runDirectory, `live.json.${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify(info), { flag: 'wx', mode: 0o600 })
      renameSync(temp, join(runDirectory, 'live.json'))
    } catch {
      logger.warn('live.partInfo.writeFailed', { sessionId: this.sessionId })
    } finally { rmSync(temp, { force: true }) }
  }

  private inAdBreak = false
  private slowNetwork = false
  private chatConnected = false

  /** Add a line to the session's activity log (published with the next update). */
  private log(text: string, tone: LiveActivityTone = 'info'): void {
    this.state.activity = [...this.state.activity, { at: new Date().toISOString(), text, tone }].slice(-MAX_LIVE_ACTIVITY)
  }

  private update(change: Partial<LiveSessionState>): void {
    Object.assign(this.state, change)
    this.onChange({ ...this.state })
  }

  private finished = false
  private finish(status: 'ended' | 'error', message: string | null): void {
    if (this.finished) return
    this.finished = true
    for (const jobId of this.openJobs) {
      activeChunkJobs.delete(jobId)
      try { finishRunRecord(this.outputDirectory, jobId, 'failed', 'Live recording stopped before this part was clipped.') } catch { /* Best effort. */ }
    }
    this.openJobs.clear()
    if (status === 'error' && message && this.state.activity.at(-1)?.text !== message) this.log(message, 'warn')
    this.update({ status, message, processingPart: null, recording: null, clipping: null, endedAt: new Date().toISOString() })
    this.onExit()
  }
}

/** Tests only. */
export function resetLiveSessionMemory(): void {
  keptByChannel.clear()
  activeChunkJobs.clear()
}

/** The runner's download speed report, when well formed. */
function liveNetwork(value: unknown): LiveNetwork | null {
  if (!value || typeof value !== 'object') return null
  const { mbps, needed_mbps: neededMbps, slow } = value as Record<string, unknown>
  const rate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000
  return rate(mbps) && rate(neededMbps) && typeof slow === 'boolean' ? { mbps, neededMbps, slow } : null
}
