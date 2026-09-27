import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BRIDGE_CONTRACT_VERSION } from '../../shared/job-contract'
import { LIVE_OVERLAP_SECONDS, selectLiveClips, type KeptLiveClip, type LiveChannel, type LiveSessionState } from '../../shared/live'
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

interface ChunkPlacement { jobId: string; part: number; streamOffsetSeconds: number }

function placement(message: Record<string, unknown>): ChunkPlacement | null {
  const { job_id: jobId, part, stream_offset_s: offset } = message
  if (typeof jobId !== 'string' || !UUID.test(jobId) || !Number.isInteger(part) || (part as number) < 1 || !finite(offset) || offset < 0) return null
  return { jobId, part: part as number, streamOffsetSeconds: offset }
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
      startedAt: new Date().toISOString(), endedAt: null, message: null
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
      overlap_seconds: LIVE_OVERLAP_SECONDS,
      max_clips_per_chunk: this.channel.maxClipsPerChunk,
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
        if (message.status === 'recording' && !this.stopping) this.update({ status: 'recording' })
        break
      case 'progress': {
        const { part, recorded_s: seconds, part_s: target, gaps, ads } = message
        if (Number.isInteger(part) && (part as number) >= 1 && finite(seconds) && seconds >= 0 && finite(target) && target > 0 &&
            Number.isInteger(gaps) && (gaps as number) >= 0 && Number.isInteger(ads) && (ads as number) >= 0) {
          this.update({ recording: { part: part as number, seconds, targetSeconds: target, gaps: gaps as number, ads: ads as number } })
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
        this.update({ processingPart: chunk.part })
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
          this.update({ partsDone: this.state.partsDone + 1, processingPart: null, message: text })
        })
        break
      }
      case 'stream_ended':
        this.enqueue(async () => this.update({ status: 'ended', message: message.reason === 'limit'
          ? 'Stopped after 12 hours of recording.' : message.reason === 'offline' ? 'The channel is not live right now.' : null }))
        break
      case 'error': {
        const text = safeText(message.message, 'Live recording failed.')
        const hint = message.hint ? safeText(message.hint, '') : ''
        this.enqueue(async () => this.update({ status: 'error', message: hint ? `${text} ${hint}` : text }))
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
      this.update({ partsDone: this.state.partsDone + 1, processingPart: null, message: 'A clipped part could not be read from the library.' })
      return
    }
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
    this.update({
      partsDone: this.state.partsDone + 1, processingPart: null, clipsMade: this.state.clipsMade + output.clips.length,
      clipsQueued: this.state.clipsQueued + queued, message
    })
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
    this.update({ status, message, processingPart: null, recording: null, endedAt: new Date().toISOString() })
    this.onExit()
  }
}

/** Tests only. */
export function resetLiveSessionMemory(): void {
  keptByChannel.clear()
  activeChunkJobs.clear()
}
