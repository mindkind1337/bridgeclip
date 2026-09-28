import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Film, ListTree, MonitorPlay, Play, Plus, Radio, RefreshCw, Square, Trash2, Twitch, Youtube } from 'lucide-react'
import {
  DEFAULT_LIVE_CHANNEL, MAX_LIVE_SESSIONS, canonicalLiveChannel, streamClock, type LiveActivity, type LiveChannel, type ChannelLiveSummary, type LiveChannelClip, type LiveChannelInput,
  type LiveClipSettings, type LiveOverview, type LiveSessionState
} from '../../shared/live'
import type { Automation } from '../../shared/automations'
import { DURATION_OPTIONS } from '../../shared/job-contract'
import { CAPTION_PRESET_NAMES } from '../components/CaptionPresetPicker'
import { ClipPlayerDialog } from '../components/ClipPlayerDialog'
import { Badge, StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Segmented } from '../components/ui/Segmented'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { useSettingsStore } from '../store/use-settings-store'
import { isRecordingState, useLiveStore } from '../store/use-live-store'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
import type { Page as PageName } from '../components/Sidebar'

/** Live clips are short-form: longer presets cannot fit in one recorded part. */
const LIVE_DURATIONS = DURATION_OPTIONS.filter((option) => ['xshort', 'short', 'medium', 'long'].includes(option.id))

const STATUS: Record<LiveSessionState['status'], { label: string; tone: 'success' | 'accent' | 'warning' | 'danger' | 'idle' }> = {
  resolving: { label: 'Opening stream', tone: 'accent' },
  recording: { label: 'Recording', tone: 'danger' },
  stopping: { label: 'Finishing last part', tone: 'warning' },
  ended: { label: 'Ended', tone: 'idle' },
  error: { label: 'Stopped with an error', tone: 'warning' },
  offline: { label: 'Offline', tone: 'idle' }
}

const PLATFORM: Record<LiveChannel['platform'], { tile: string; icon: React.ReactNode }> = {
  twitch: { tile: 'bg-[#9146ff]/20 text-[#b98cff]', icon: <Twitch className="h-4 w-4" aria-label="Twitch" /> },
  youtube: { tile: 'bg-[#ff0033]/15 text-[#ff5c7a]', icon: <Youtube className="h-4 w-4" aria-label="YouTube" /> },
  // No Kick glyph in the icon set: its wordmark initial in the brand green.
  kick: { tile: 'bg-[#53fc18]/15 text-[#53fc18]', icon: <span aria-label="Kick" className="text-sm font-black leading-none">K</span> }
}

function inputFor(channel: LiveChannel): LiveChannelInput {
  const { url, displayName, enabled, automationId, clip, minScore, maxClipsPerChunk, maxPostsPerHour, chunkMinutes, chatPriority } = channel
  return { url, displayName, enabled, automationId, clip: { ...clip, durationRanges: [...clip.durationRanges] }, minScore, maxClipsPerChunk,
    maxPostsPerHour, chunkMinutes, chatPriority: chatPriority === true }
}

const HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

function missedLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const isRunning = isRecordingState

export function LivePage({ onNavigate }: { onNavigate: (page: PageName) => void }): React.JSX.Element {
  const openrouterConfigured = useSettingsStore((state) => state.openrouterConfigured)
  const zernioConfigured = useSettingsStore((state) => state.zernioConfigured)
  const overview = useLiveStore((store) => store.overview)
  const setOverview = useLiveStore((store) => store.set)
  const [automations, setAutomations] = useState<Automation[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])

  // App keeps the overview current; refresh once here to surface a load error.
  useEffect(() => {
    void getApi().live.overview().then(setOverview).catch((cause) => setError(errorMessage(cause, 'Could not load live channels.')))
  }, [setOverview])

  useEffect(() => {
    if (!zernioConfigured) return
    void getApi().automations.list().then(setAutomations).catch(() => {})
  }, [zernioConfigured])

  const run = async (key: string, action: () => Promise<LiveOverview>): Promise<boolean> => {
    setBusy(key); setError(null)
    try {
      setOverview(await action())
      return true
    } catch (cause) {
      setError(errorMessage(cause, 'That did not work. Try again.'))
      return false
    } finally { setBusy(null) }
  }

  const add = async (): Promise<void> => {
    if (!canonicalLiveChannel(url)) { setError('Use a Twitch (twitch.tv/name), Kick (kick.com/name) or YouTube (youtube.com/@handle) channel.'); return }
    if (await run('add', () => getApi().live.addChannel({ ...DEFAULT_LIVE_CHANNEL, url }))) setUrl('')
  }

  const sessions = new Map((overview?.sessions ?? []).map((state) => [state.channelId, state]))
  const recording = [...sessions.values()].filter(isRunning).length

  return (
    <Page width="narrow">
      <PageHeader
        title="Live"
        description="Follow Twitch, Kick and YouTube channels. When one goes live, BridgeClip records it in parts, clips each part, and queues the best moments for posting."
        actions={overview && overview.channels.length > 0 && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === 'check'}
            onClick={() => void run('check', () => getApi().live.checkNow())}>Check now</Button>
        )}
      />

      <div className="mt-4 space-y-3">
        {!openrouterConfigured && (
          <Callout tone="warning" title="Add an OpenRouter key" action={<Button size="sm" onClick={() => onNavigate('settings')}>Open Settings</Button>}>
            Live clipping transcribes and plans each part with OpenRouter, like any other run.
          </Callout>
        )}
        {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}

        <Panel className="flex flex-wrap items-center gap-2">
          <TextInput
            inputSize="sm"
            className="min-w-[260px] flex-1"
            aria-label="Channel link"
            placeholder="twitch.tv/name, kick.com/name or youtube.com/@handle"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void add() }}
          />
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'add'} disabled={!url.trim()} onClick={() => void add()}>
            Follow channel
          </Button>
        </Panel>

        {!overview ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : overview.channels.length === 0 ? (
          <EmptyState icon={<Radio className="h-5 w-5" />} title="No channels yet"
            description="Paste a Twitch or YouTube channel link above. Channels are checked every minute while BridgeClip is open." />
        ) : (
          <div className="space-y-2">
            {overview.channels.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                state={sessions.get(channel.id)}
                check={overview.checks[channel.id]}
                automations={automations}
                expanded={expanded === channel.id}
                busy={busy}
                canStart={recording < MAX_LIVE_SESSIONS && openrouterConfigured}
                onToggle={() => setExpanded(expanded === channel.id ? null : channel.id)}
                onStart={() => void run(`start:${channel.id}`, () => getApi().live.start(channel.id))}
                onStop={() => void run(`stop:${channel.id}`, () => getApi().live.stop(channel.id))}
                onWatch={() => void getApi().live.watch(channel.id).catch((cause) => setError(errorMessage(cause, 'Could not open the player.')))}
                onSave={(input) => run(`save:${channel.id}`, () => getApi().live.updateChannel(channel.id, input))}
                onRemove={() => setConfirm({
                  title: 'Stop following this channel?',
                  body: <>{channel.displayName} is removed from Live. A recording in progress stops now; clips already made stay in the Library.</>,
                  confirmLabel: 'Remove channel',
                  onConfirm: () => void run(`remove:${channel.id}`, () => getApi().live.removeChannel(channel.id))
                })}
              />
            ))}
          </div>
        )}

        <p className="px-1 text-2xs leading-snug text-ink-subtle">
          BridgeClip must stay open to follow channels. Each part appears in the Library as “channel live … (part N)”. Clips that pass the
          filters go to the linked automation; set it to post continuously to publish during the stream. Up to {MAX_LIVE_SESSIONS} streams can be recorded at once.
        </p>
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function ChannelCard({ channel, state, check, automations, expanded, busy, canStart, onToggle, onStart, onStop, onWatch, onSave, onRemove }: {
  channel: LiveChannel
  state: LiveSessionState | undefined
  check: LiveOverview['checks'][string] | undefined
  automations: Automation[]
  expanded: boolean
  busy: string | null
  canStart: boolean
  onToggle: () => void
  onStart: () => void
  onStop: () => void
  onWatch: () => void
  onSave: (input: LiveChannelInput) => Promise<boolean>
  onRemove: () => void
}): React.JSX.Element {
  const running = isRunning(state)
  const recording = running ? state?.recording : null
  const status = state ? STATUS[state.status] : null
  const automation = automations.find((item) => item.id === channel.automationId)

  return (
    <section aria-label={channel.displayName}>
    <Panel padded={false} className="overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', PLATFORM[channel.platform].tile)}>
          {PLATFORM[channel.platform].icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-ink">{channel.displayName}</h2>
            {status && (running || state?.status === 'error')
              ? <Badge tone={status.tone === 'idle' ? 'neutral' : status.tone} icon={<StatusDot tone={status.tone} pulse={running} />}>{status.label}</Badge>
              : check?.live ? <Badge tone="danger" icon={<StatusDot tone="danger" pulse />}>Live now</Badge> : null}
            {!channel.enabled && (
              <Badge tone={check?.live && !running ? 'warning' : 'neutral'}>
                <span title="Record automatically when this channel goes live is off: turn on Auto-record, or press Record">Auto-record off</span>
              </Badge>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-2xs text-ink-muted">
            {state && (running || state.partsDone > 0) ? (
              <>
                <span title="Since this recording started (it restarts with the app); the clip list below counts the whole live">
                  This recording: <span className="tabular text-ink">{state.partsDone}</span> part{state.partsDone === 1 ? '' : 's'} clipped</span>
                <span>· <span className="tabular text-ink">{state.clipsMade}</span> clips</span>
                <span>· <span className="tabular text-ink">{state.clipsQueued}</span> queued</span>
              </>
            ) : check ? (
              <span>
                {check.live ? <>Live{check.title ? <> · <span className="text-ink">{check.title}</span></> : null}</> : 'Offline'}
                {' '}· checked {formatRelativeDate(check.at)}
                {check.live && !channel.enabled ? ' · not recording: press Record to record it' : ''}
              </span>
            ) : (
              <span>Waiting for the first check</span>
            )}
            <span>· {automation ? <>queues to <span className="text-ink">{automation.name}</span></> : 'clips stay in the Library'}</span>
          </p>
          {running && state?.recordingStartedAt && (
            <p className="mt-0.5 text-2xs text-ink-muted">
              {state.streamStartedAt
                ? <>Live since <span className="text-ink">{HOUR.format(new Date(state.streamStartedAt))}</span> · </>
                : null}
              recording since <span className="text-ink">{HOUR.format(new Date(state.recordingStartedAt))}</span>
              {state.streamStartedAt && (() => {
                const missed = Date.parse(state.recordingStartedAt) - Date.parse(state.streamStartedAt)
                return missed > 120_000
                  ? <span className="text-ink-subtle"> · first {missedLabel(missed)} not recorded</span>
                  : <span className="text-success"> · from the start</span>
              })()}
            </p>
          )}
          {recording && (
            <div className="mt-1.5 max-w-[360px]">
              <div className="flex justify-between text-2xs text-ink-muted">
                <span>Recording part {recording.part} · <span className="tabular text-ink">{clock(recording.seconds)}</span> / {clock(recording.targetSeconds)}</span>
                {(recording.ads > 0 || recording.gaps > 0) && (
                  <span title="Twitch does not send the stream during ads; dropped segments are lost">
                    {recording.ads > 0 && `${recording.ads} ad segment${recording.ads === 1 ? '' : 's'} skipped`}
                    {recording.ads > 0 && recording.gaps > 0 && ' · '}
                    {recording.gaps > 0 && `${recording.gaps} gap${recording.gaps === 1 ? '' : 's'}`}
                  </span>
                )}
              </div>
              {recording.network?.slow && (
                <p role="status" className="mt-1 text-2xs text-warning"
                  title="Segments arrive slower than the live goes on, so Twitch/YouTube/Kick drop them before they are downloaded">
                  Internet too slow: {recording.network.mbps} Mb/s received, this stream needs about {recording.network.neededMbps} Mb/s · parts are lost
                </p>
              )}
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={`Part ${recording.part} recorded`}
                aria-valuemin={0} aria-valuemax={recording.targetSeconds} aria-valuenow={Math.round(recording.seconds)}>
                <div className="h-full rounded-full bg-danger/80 transition-[width] duration-1000"
                  style={{ width: `${Math.min(100, (recording.seconds / recording.targetSeconds) * 100)}%` }} />
              </div>
            </div>
          )}
          {state?.clipping?.step && (
            <div className="mt-1.5 max-w-[360px]">
              <div className="flex justify-between gap-2 text-2xs text-ink-muted">
                <span className="truncate">Clipping part {state.clipping.part} · <span className="text-ink">{state.clipping.step.replace(/\.\.\.$/, '')}</span></span>
                <span className="tabular">{Math.round(state.clipping.percent)}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={`Part ${state.clipping.part} clipped`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.clipping.percent)}>
                <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${state.clipping.percent}%` }} />
              </div>
            </div>
          )}
          {state?.message && <p className={cn('mt-1 text-2xs', state.status === 'error' ? 'text-warning' : 'text-ink-muted')}>{state.message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <label className="mr-1.5 flex items-center gap-1.5 text-2xs text-ink-muted"
            title="Record automatically when this channel goes live">
            <Switch checked={channel.enabled} disabled={busy === `save:${channel.id}`} label="Record automatically when live"
              onChange={(enabled) => void onSave({ ...inputFor(channel), enabled })} />
            Auto-record
          </label>
          <Button size="sm" variant="ghost" icon={<MonitorPlay className="h-3.5 w-3.5" />} onClick={onWatch}
            title="Watch and listen to this channel in a BridgeClip window">Watch</Button>
          {running ? (
            <Button size="sm" variant="secondary" icon={<Square className="h-3 w-3" />} loading={busy === `stop:${channel.id}`} onClick={onStop}
              title={state?.status === 'stopping' ? 'Stop now, without clipping the part being recorded' : 'Finish and clip the current part, then stop'}>
              {state?.status === 'stopping' ? 'Stop now' : 'Stop'}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<Radio className="h-3 w-3" />} loading={busy === `start:${channel.id}`} disabled={!canStart}
              title={canStart ? 'Record now if the channel is live' : 'Another recording must finish first, or add an OpenRouter key'} onClick={onStart}>Record</Button>
          )}
          <Button size="sm" variant="ghost" iconOnly aria-label="Channel settings" aria-expanded={expanded} onClick={onToggle}
            icon={<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />} />
        </div>
      </div>
      {/* Older main processes (before a restart) send states without these fields. */}
      <ChannelClips channel={channel} live={running} ended={state?.status === 'ended' && !running ? state : null}
        refreshKey={`${state?.partsDone ?? 0}-${state?.status ?? 'none'}`} />
      {(state?.activity?.length ?? 0) > 0 && <ActivityLog entries={state!.activity} live={running} />}
      {expanded && <ChannelSettings channel={channel} automations={automations} saving={busy === `save:${channel.id}`} onSave={onSave} onRemove={onRemove} />}
    </Panel>
    </section>
  )
}

/**
 * Clips of this channel's current live (or today), read from the library so they
 * survive restarts: play them here, or open the replay at their moment.
 */
const WHEN = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const AT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

function spanLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`
}

/** When the last live began and ended, from the library (and the session, when it saw the stream end). */
function lastLiveLabel(summary: ChannelLiveSummary, ended: LiveSessionState | null): string {
  const began = summary.streamStartedAt ?? summary.firstRecordedAt
  const endedAt = ended?.endedAt && !ended.message ? ended.endedAt : null
  const end = endedAt ?? summary.lastRecordedAt
  const sameDay = new Date(began).toDateString() === new Date(end).toDateString()
  return `Last live: ${summary.streamStartedAt ? 'started' : 'recorded from'} ${WHEN.format(new Date(began))} · ` +
    `${endedAt ? 'ended' : 'last recorded'} ${sameDay ? AT.format(new Date(end)) : WHEN.format(new Date(end))} · ${spanLabel(Date.parse(end) - Date.parse(began))}`
}

function ChannelClips({ channel, live, ended, refreshKey }: {
  channel: LiveChannel
  live: boolean
  ended: LiveSessionState | null
  refreshKey: string
}): React.JSX.Element | null {
  const [data, setData] = useState<{ clips: LiveChannelClip[]; parts: number; live: ChannelLiveSummary | null } | null>(null)
  const [all, setAll] = useState(false)
  const [playing, setPlaying] = useState<LiveChannelClip | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = (): void => { void getApi().live.channelClips(channel.id).then((result) => { if (active) setData(result) }).catch(() => {}) }
    load()
    const timer = setInterval(load, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [channel.id, refreshKey])

  if (!data || (data.clips.length === 0 && !data.live)) return null
  const shown = all ? data.clips : data.clips.slice(0, 4)
  return (
    <div className="border-t border-white/[0.06] px-3.5 py-2">
      {!live && data.live && <p className="mb-1 text-2xs text-ink-muted">{lastLiveLabel(data.live, ended)}</p>}
      <div className="mb-1 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-2xs font-medium text-ink-muted">
          <Film aria-hidden className="h-3 w-3" />
          {data.clips.length} clip{data.clips.length === 1 ? '' : 's'} from {live ? 'this' : 'the last'} live · {data.parts} part{data.parts === 1 ? '' : 's'}
        </p>
        {data.clips.length > 4 && (
          <button type="button" className="text-2xs text-ink-subtle hover:text-ink" onClick={() => setAll(!all)}>
            {all ? 'Show less' : `Show all ${data.clips.length}`}
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {shown.map((clip) => (
          <li key={`${clip.runDir}-${clip.clipIndex}`} className="flex items-center gap-2 text-2xs">
            <button type="button" onClick={() => setPlaying(clip)} aria-label={`Play “${clip.title}”`} title="Play here"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-ink-muted hover:bg-accent/20 hover:text-ink">
              <Play className="ml-px h-3 w-3" fill="currentColor" />
            </button>
            <span className="min-w-0 flex-1 truncate text-ink" title={clip.title}>{clip.title}</span>
            {clip.chatReaction && (
              <span className="shrink-0 text-warning"
                title={`Made from a chat spike: ${clip.chatReaction.count} messages in 10 s, ${clip.chatReaction.ratio.toFixed(1)} times the usual rate`}>
                🔥 ×{clip.chatReaction.ratio.toFixed(1)}{clip.chatReaction.reaction ? ` ${clip.chatReaction.reaction}` : ''}
              </span>
            )}
            <span className="shrink-0 font-mono tabular text-ink-subtle" title="Score">{Math.round(clip.score * 100)}</span>
            <span className="w-24 shrink-0 text-right text-ink-subtle">
              {clip.intoStream !== null ? `${streamClock(clip.intoStream)} in live` : `part ${clip.part}`}
            </span>
            {clip.hasReplay ? (
              <button type="button" aria-label={`Watch “${clip.title}” in the replay`} title="Open the replay at this moment"
                className="shrink-0 text-ink-subtle hover:text-accent-hover"
                onClick={() => { setError(null); void getApi().live.openReplay(clip.runDir, clip.startSeconds).catch((cause) => setError(errorMessage(cause, 'Could not open the replay.'))) }}>
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            ) : <span className="w-3.5 shrink-0" />}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-1 text-2xs text-warning">{error}</p>}
      {playing && <ClipPlayerDialog filePath={playing.clipPath} title={playing.title} vertical={channel.clip.aspectRatio === '9:16'} onClose={() => setPlaying(null)} />}
    </div>
  )
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** What the live engine did, newest first: the last few lines, or everything on demand. */
function ActivityLog({ entries, live }: { entries: LiveActivity[]; live: boolean }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const shown = [...entries].reverse().slice(0, all ? entries.length : 4)
  return (
    <div className="border-t border-white/[0.06] px-3.5 py-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-2xs font-medium text-ink-muted">
          <ListTree aria-hidden className="h-3 w-3" />Activity{live && <StatusDot tone="danger" pulse className="ml-0.5" />}
        </p>
        {entries.length > 4 && (
          <button type="button" className="text-2xs text-ink-subtle hover:text-ink" onClick={() => setAll(!all)}>
            {all ? 'Show less' : `Show all ${entries.length}`}
          </button>
        )}
      </div>
      <ol aria-live="polite" className={cn('space-y-0.5', all && 'max-h-72 overflow-y-auto pr-1')}>
        {shown.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="flex gap-2 text-2xs leading-snug">
            <time dateTime={entry.at} className="shrink-0 font-mono tabular text-ink-subtle">{TIME.format(new Date(entry.at))}</time>
            <span className={cn(entry.tone === 'warn' ? 'text-warning' : entry.tone === 'good' ? 'text-success' : 'text-ink-muted')}>{entry.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ChannelSettings({ channel, automations, saving, onSave, onRemove }: {
  channel: LiveChannel
  automations: Automation[]
  saving: boolean
  onSave: (input: LiveChannelInput) => Promise<boolean>
  onRemove: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<LiveChannelInput>(() => inputFor(channel))
  useEffect(() => setDraft(inputFor(channel)), [channel])
  const dirty = JSON.stringify(draft) !== JSON.stringify(inputFor(channel))
  const setClip = (change: Partial<LiveClipSettings>): void => setDraft({ ...draft, clip: { ...draft.clip, ...change } })
  const toggleDuration = (id: string): void => {
    const next = draft.clip.durationRanges.includes(id) ? draft.clip.durationRanges.filter((item) => item !== id) : [...draft.clip.durationRanges, id]
    if (next.length) setClip({ durationRanges: next })
  }
  const numberOptions = (values: number[], label: (value: number) => string): { value: string; label: string }[] =>
    values.map((value) => ({ value: String(value), label: label(value) }))

  return (
    <div className="space-y-0.5 border-t border-white/[0.06] py-2">
      <Row label="Follow">
        <div className="flex items-center gap-2 text-2xs text-ink-muted">
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Record automatically when live" />
          Record automatically when this channel goes live
        </div>
      </Row>
      <Row label="Name">
        <TextInput inputSize="sm" className="max-w-[260px]" aria-label="Channel name" value={draft.displayName ?? ''} maxLength={80}
          onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
      </Row>
      <Row label="Clipping" hint="Economy uses a lower-cost planner and costs much less for long streams.">
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented size="sm" label="Clipping mode" value={draft.clip.clippingMode} onChange={(clippingMode) => setClip({ clippingMode })}
            options={[{ value: 'quality', label: 'Quality' }, { value: 'economy', label: 'Economy' }]} />
          <Segmented size="sm" label="Aspect ratio" value={draft.clip.aspectRatio} onChange={(aspectRatio) => setClip({ aspectRatio })}
            options={[{ value: '9:16', label: 'Vertical' }, { value: '16:9', label: 'Horizontal' }]} />
        </div>
      </Row>
      <Row label="Length">
        <div role="group" aria-label="Clip lengths" className="flex flex-wrap gap-1">
          {LIVE_DURATIONS.map((option) => {
            const on = draft.clip.durationRanges.includes(option.id)
            return (
              <button key={option.id} type="button" aria-pressed={on} onClick={() => toggleDuration(option.id)}
                className={cn('h-7 rounded-full border px-2.5 text-2xs transition-colors',
                  on ? 'border-accent/40 bg-accent/[0.14] text-ink' : 'border-white/[0.08] text-ink-muted hover:text-ink')}>
                {option.label} <span className="text-ink-subtle">{option.range}</span>
              </button>
            )
          })}
        </div>
      </Row>
      <Row label="Captions">
        <div className="flex flex-wrap items-center gap-2">
          <Switch checked={draft.clip.includeCaptions} onChange={(includeCaptions) => setClip({ includeCaptions })} label="Burn in captions" />
          <Select size="sm" className="w-[160px]" aria-label="Caption style" disabled={!draft.clip.includeCaptions} value={draft.clip.captionPreset}
            onChange={(captionPreset) => setClip({ captionPreset })}
            options={Object.entries(CAPTION_PRESET_NAMES).map(([value, label]) => ({ value, label }))} />
        </div>
      </Row>
      <Row label="Parts" hint="Shorter parts post sooner; longer parts give the AI more context to judge a moment.">
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
          <Select size="sm" className="w-[120px]" aria-label="Part length" value={String(draft.chunkMinutes)}
            onChange={(value) => setDraft({ ...draft, chunkMinutes: Number(value) })} options={numberOptions([5, 10, 15, 20], (value) => `${value} min`)} />
          <span>up to</span>
          <Select size="sm" className="w-[110px]" aria-label="Clips per part" value={String(draft.maxClipsPerChunk)}
            onChange={(value) => setDraft({ ...draft, maxClipsPerChunk: Number(value) })}
            options={numberOptions([1, 2, 3, 4, 5], (value) => `${value} clip${value === 1 ? '' : 's'}`)} />
          <span>each</span>
        </div>
      </Row>
      {channel.platform !== 'youtube' && (
        <Row label="Chat" hint="Each part gets a clip of its biggest chat laugh (KEKW, LUL, 😂…), with the moment that caused it, even if the AI ranked it lower.">
          <div className="flex items-center gap-2 text-2xs text-ink-muted">
            <Switch checked={draft.chatPriority === true} onChange={(chatPriority) => setDraft({ ...draft, chatPriority })} label="Chat priority" />
            Chat priority: always clip the biggest laugh
          </div>
        </Row>
      )}
      <Row label="Posting" hint="Only clips at or above the score are queued. Every clip is still saved to the Library.">
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
          <Select size="sm" className="w-[200px]" aria-label="Automation" value={draft.automationId ?? ''}
            onChange={(value) => setDraft({ ...draft, automationId: value || null })}
            options={[{ value: '', label: 'Library only' }, ...automations.map((item) => ({ value: item.id, label: item.name }))]} />
          <span>score ≥</span>
          <Select size="sm" className="w-[90px]" aria-label="Minimum score" value={String(draft.minScore)}
            onChange={(value) => setDraft({ ...draft, minScore: Number(value) })} options={numberOptions([0, 0.5, 0.6, 0.7, 0.8, 0.9], (value) => `${Math.round(value * 100)}`)} />
          <span>at most</span>
          <Select size="sm" className="w-[110px]" aria-label="Posts per hour" value={String(draft.maxPostsPerHour)}
            onChange={(value) => setDraft({ ...draft, maxPostsPerHour: Number(value) })}
            options={numberOptions([1, 2, 3, 4, 6, 8, 12], (value) => `${value} per hour`)} />
        </div>
      </Row>
      <div className="flex items-center justify-between px-3.5 pt-2">
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-3 w-3" />} onClick={onRemove}>Remove</Button>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(inputFor(channel))}>Discard</Button>
          <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={() => void onSave(draft)}>Save</Button>
        </div>
      </div>
      <p className="px-3.5 pt-1 text-2xs text-ink-subtle">Changes apply to the next recording.</p>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-x-3 gap-y-0.5 px-3.5 py-1.5 sm:grid-cols-[80px_minmax(0,1fr)]">
      <p className="text-xs font-medium leading-7 text-ink-muted">{label}</p>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-2xs leading-snug text-ink-subtle">{hint}</p>}
      </div>
    </div>
  )
}
