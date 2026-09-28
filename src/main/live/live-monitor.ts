import { spawn, type ChildProcess } from 'child_process'
import { BRIDGE_CONTRACT_VERSION } from '../../shared/job-contract'
import { MAX_LIVE_SESSIONS, type LiveOverview, type LiveSessionState } from '../../shared/live'
import { logger } from '../logger'
import {
  boundedBridgeLines, bridgeSpawnEnvironment, getBridgeRunnerPath, getEnginePath, preflightCheck,
  resolvePythonPath, terminateProcessTree, workRoot
} from '../pipeline-runner'
import { loadSettings } from '../settings-store'
import { getLiveChannel, listLiveChannels } from './live-channels'
import { LiveSession } from './live-session'

const CHECK_INTERVAL_MS = 60_000
const PROBE_TIMEOUT_MS = 3 * 60_000
/** After a stream ends, wait before recording the same channel again (a reconnecting streamer). */
const RESTART_COOLDOWN_MS = 5 * 60_000
/** After an engine failure, retry sooner: the stream is probably still live. */
const RETRY_AFTER_ERROR_MS = 60_000
const MAX_TITLE = 200

const sessions = new Map<string, LiveSession>()
/** The last state of every session this app run, including finished ones. */
const states = new Map<string, LiveSessionState>()
const endedAt = new Map<string, number>()
const checks: LiveOverview['checks'] = {}
let probe: ChildProcess | null = null
let timer: NodeJS.Timeout | null = null
let broadcast: (overview: LiveOverview) => void = () => {}

export function getLiveOverview(): LiveOverview {
  const channels = listLiveChannels()
  const ids = new Set(channels.map((channel) => channel.id))
  return {
    channels,
    sessions: [...states.values()].filter((state) => ids.has(state.channelId)).map((state) => ({ ...state })),
    checks: Object.fromEntries(Object.entries(checks).filter(([id]) => ids.has(id)))
  }
}

function publish(): void {
  try { broadcast(getLiveOverview()) } catch { logger.warn('live.broadcast.failed') }
}

export function startLiveSession(channelId: unknown): LiveOverview {
  const channel = getLiveChannel(channelId)
  if (sessions.has(channel.id)) return getLiveOverview()
  if (sessions.size >= MAX_LIVE_SESSIONS) throw new Error(`Up to ${MAX_LIVE_SESSIONS} live streams can be recorded at the same time.`)
  if (!loadSettings().openrouterApiKey) throw new Error('Add an OpenRouter API key in Settings before recording a live stream.')
  const session = new LiveSession(channel, (state) => { states.set(channel.id, state); publish() }, () => {
    sessions.delete(channel.id)
    // Count the cooldown from a point that leaves only the short retry delay after a failure.
    endedAt.set(channel.id, session.state.status === 'error' ? Date.now() - RESTART_COOLDOWN_MS + RETRY_AFTER_ERROR_MS : Date.now())
    publish()
  })
  sessions.set(channel.id, session)
  states.set(channel.id, { ...session.state })
  session.start()
  publish()
  return getLiveOverview()
}

export function stopLiveSession(channelId: unknown): LiveOverview {
  const channel = getLiveChannel(channelId)
  sessions.get(channel.id)?.stop()
  return getLiveOverview()
}

/** A removed channel must not keep recording. */
export function forgetLiveChannel(channelId: string): void {
  sessions.get(channelId)?.kill()
  states.delete(channelId)
  delete checks[channelId]
}

function interpreter(): { pythonPath: string; bridgePath: string; enginePath: string } | null {
  const settings = loadSettings()
  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath('live_runner.py')
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)
  return preflightCheck({ pythonPath, bridgePath, enginePath }).ok ? { pythonPath, bridgePath, enginePath } : null
}

/** Ask the engine which channels are live; resolves with url -> result. */
function runProbe(urls: string[]): Promise<Map<string, { live: boolean; title: string | null }>> {
  return new Promise((resolve) => {
    const results = new Map<string, { live: boolean; title: string | null }>()
    const paths = interpreter()
    if (!paths) { resolve(results); return }
    let child: ChildProcess
    try {
      child = spawn(paths.pythonPath, [paths.bridgePath], {
        cwd: paths.enginePath,
        env: bridgeSpawnEnvironment(loadSettings(), paths.enginePath, workRoot()),
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32'
      })
    } catch { resolve(results); return }
    probe = child
    const timeout = setTimeout(() => terminateProcessTree(child, true), PROBE_TIMEOUT_MS)
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${JSON.stringify({ contract_version: BRIDGE_CONTRACT_VERSION, mode: 'probe', channels: urls })}\n`)
    if (child.stdout) {
      boundedBridgeLines(child.stdout, 1024 * 1024, () => terminateProcessTree(child, true)).on('line', (line) => {
        try {
          const message = JSON.parse(line) as { type?: unknown; url?: unknown; live?: unknown; title?: unknown }
          if (message.type !== 'probe' || typeof message.url !== 'string' || !urls.includes(message.url)) return
          // eslint-disable-next-line no-control-regex
          const title = typeof message.title === 'string' ? message.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TITLE) : null
          results.set(message.url, { live: message.live === true, title })
        } catch { /* Ignore anything that is not a probe line. */ }
      })
    }
    const done = (): void => { clearTimeout(timeout); if (probe === child) probe = null; resolve(results) }
    child.on('error', done)
    child.on('close', done)
  })
}

let checking = false
/** A check asked for while one runs (e.g. a channel was just added) runs right after it. */
let checkAgain = false
export async function checkLiveChannels(): Promise<void> {
  if (checking) { checkAgain = true; return }
  checking = true
  checkAgain = false
  try {
    const now = Date.now()
    // Every channel is checked, so the page shows who is live even when auto-recording is off.
    const due = listLiveChannels().filter((channel) => !sessions.has(channel.id))
    if (!due.length) return
    const canRecord = Boolean(loadSettings().openrouterApiKey)
    const results = await runProbe(due.map((channel) => channel.url))
    const at = new Date().toISOString()
    for (const channel of due) {
      const result = results.get(channel.url)
      if (!result) continue
      checks[channel.id] = { at, live: result.live, title: result.title }
      if (!result.live || !channel.enabled || !canRecord || sessions.has(channel.id) || sessions.size >= MAX_LIVE_SESSIONS) continue
      if (now - (endedAt.get(channel.id) ?? 0) < RESTART_COOLDOWN_MS) continue
      try {
        // Settings may have changed while the probe ran.
        if (getLiveChannel(channel.id).enabled) startLiveSession(channel.id)
      } catch { logger.warn('live.autoStart.failed', { channelId: channel.id }) }
    }
    publish()
  } catch {
    logger.warn('live.check.failed')
  } finally {
    checking = false
    if (checkAgain) void checkLiveChannels()
  }
}

export function startLiveMonitor(send: (overview: LiveOverview) => void): void {
  broadcast = send
  if (timer) return
  timer = setInterval(() => { void checkLiveChannels() }, CHECK_INTERVAL_MS)
  timer.unref()
  setTimeout(() => { void checkLiveChannels() }, 10_000).unref()
}

/** App exit must not leave recordings or probes running. */
export function stopAllLiveForQuit(): void {
  if (timer) { clearInterval(timer); timer = null }
  for (const session of sessions.values()) session.kill()
  if (probe) terminateProcessTree(probe, true)
}

export function hasActiveLiveSessions(): boolean { return sessions.size > 0 }
