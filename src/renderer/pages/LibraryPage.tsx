import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Clapperboard, FileText, FolderOpen, LayoutGrid, List, ListVideo, Radio, RefreshCw, Search, Sparkles } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatClockTime, formatDayLabel, formatRelativeDate, formatUsd, localFileUrl } from '../lib/utils'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import { useSettingsStore } from '../store/use-settings-store'
import type { JobOutput } from '../store/use-job-store'
import { parseJobOutput } from '../../shared/job-output'
import type { HistoryEntry } from '../../preload/index'
import { BackLink, ClipList } from '../components/ClipList'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { EmptyState } from '../components/ui/EmptyState'
import { Callout } from '../components/ui/Callout'
import { Skeleton } from '../components/ui/Skeleton'
import { Segmented } from '../components/ui/Segmented'
import { TranscriptDialog } from '../components/TranscriptDialog'
import { LiveClipsTable } from '../components/LiveClipsTable'
import { LivePlatformIcon } from '../components/LivePlatformIcon'
import { groupLibraryByLive, type LibraryLive } from '../../shared/live'
import type { Page as AppPage } from '../components/Sidebar'

/** Lives: channels, their lives and each live's best clips. Grid / List: every run, newest first. */
type LibraryView = 'lives' | 'grid' | 'list'
const VIEW_STORAGE_KEY = 'bridgeclip.library.view'

function savedView(): LibraryView {
  try {
    const value = localStorage.getItem(VIEW_STORAGE_KEY)
    return value === 'grid' || value === 'list' ? value : value === 'details' ? 'list' : 'lives'
  } catch { return 'lives' }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** "Sun, Sep 27 · live since 1:37 PM" (or "recorded from" when the broadcast start is unknown). */
function liveTitle(live: LibraryLive<HistoryEntry>): string {
  const start = live.streamStartedAt ?? live.firstRecordedAt
  return `${formatDayLabel(start)} · ${live.streamStartedAt ? 'live since' : 'recorded from'} ${formatClockTime(start)}`
}

/** When recording ran, first part to last. */
function liveSpan(live: LibraryLive<HistoryEntry>): string {
  const last = live.entries.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), live.entries[0].date)
  return `recorded ${formatClockTime(live.firstRecordedAt)} – ${formatClockTime(last)}`
}

export function LibraryPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const [view, setView] = useState<LibraryView>(savedView)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Per live: its best clips (default) or its parts.
  const [showParts, setShowParts] = useState<Set<string>>(new Set())
  const [liveTranscript, setLiveTranscript] = useState<{ outputDir: string; output: JobOutput } | null>(null)
  const chooseView = (next: LibraryView): void => {
    setView(next)
    try { localStorage.setItem(VIEW_STORAGE_KEY, next) } catch { /* A remembered view is a convenience only. */ }
  }
  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  const outputDirectory = useSettingsStore((s) => s.outputDirectory)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ entry: HistoryEntry; output: JobOutput } | null>(null)
  const requestId = useRef(0)
  const openRequestId = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const request = ++requestId.current
    setRefreshing(true)
    setError(null)
    try {
      const result = await getApi().history.list()
      if (request === requestId.current) setEntries(result.filter((entry) => entry.status === 'completed'))
    } catch (err) {
      if (request === requestId.current) {
        setEntries((previous) => previous ?? [])
        setError(errorMessage(err, 'Could not load the library. Please refresh to retry.'))
      }
    } finally {
      if (request === requestId.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    return q ? entries.filter((e) => e.videoTitle.toLowerCase().includes(q) || e.live?.channel.toLowerCase().includes(q)) : entries
  }, [entries, query])

  const totalClips = entries?.reduce((sum, e) => sum + e.clipCount, 0) ?? 0

  const openRun = async (entry: HistoryEntry): Promise<void> => {
    const request = ++openRequestId.current
    setError(null)
    try {
      const output = await getApi().history.getJob(entry.outputDir)
      if (request !== openRequestId.current) return
      if (!output) {
        setError('This run is no longer available. Its files may have moved or been removed.')
        return
      }
      const parsed = parseJobOutput(output)
      if (!parsed) {
        setError('This run has an unsupported or damaged result file.')
        return
      }
      setOpen({ entry, output: parsed })
      document.getElementById('page-scroll')?.scrollTo({ top: 0 })
    } catch (err) {
      if (request === openRequestId.current) setError(errorMessage(err, 'Could not open this run.'))
    }
  }

  const openFolder = async (entry: HistoryEntry): Promise<void> => {
    try {
      if (!await getApi().shell.openPath(entry.outputDir)) setError('This run folder is no longer available.')
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run folder.'))
    }
  }

  const openLiveTranscript = async (live: LibraryLive<HistoryEntry>): Promise<void> => {
    const last = live.entries[live.entries.length - 1]
    try {
      const output = parseJobOutput(await getApi().history.getJob(last.outputDir))
      if (output) setLiveTranscript({ outputDir: last.outputDir, output })
      else setError('This live has no readable part.')
    } catch (err) {
      setError(errorMessage(err, 'Could not open the transcript.'))
    }
  }

  const runGrid = (list: HistoryEntry[]): React.JSX.Element => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
      {list.map((entry) => (
        <RunCard key={entry.jobId} entry={entry} onOpen={() => openRun(entry)} onOpenFolder={() => void openFolder(entry)} />
      ))}
    </div>
  )

  const runList = (list: HistoryEntry[], labels?: Map<string, string>): React.JSX.Element => (
    <div className="glass overflow-hidden rounded-2xl" role="list" aria-label="Runs">
      {list.map((entry) => (
        <RunRow key={entry.jobId} entry={entry} label={labels?.get(entry.jobId)} onOpen={() => openRun(entry)} onOpenFolder={() => void openFolder(entry)} />
      ))}
    </div>
  )

  const renderLives = (): React.JSX.Element => {
    const { channels, others } = groupLibraryByLive(filtered)
    return (
      <div className="space-y-10">
        {channels.map((channel) => (
          <section key={channel.channel} aria-label={channel.channel}>
            <h2 className="mb-3 flex items-center gap-2.5 text-base font-semibold text-ink">
              <LivePlatformIcon platform={channel.platform} size="sm" />
              {channel.channel}
              <span className="text-xs font-normal text-ink-subtle">{plural(channel.lives.length, 'live')}</span>
            </h2>
            <div className="space-y-4">
              {channel.lives.map((live) => {
                const clips = live.entries.reduce((sum, entry) => sum + entry.clipCount, 0)
                const cost = live.entries.reduce((sum, entry) => sum + (entry.totalCostUsd ?? 0), 0)
                const isCollapsed = collapsed.has(live.key)
                const parts = showParts.has(live.key)
                const labels = new Map(live.entries.map((entry, index) => [entry.jobId, `Part ${index + 1} · ${formatClockTime(entry.date)}`]))
                return (
                  <article key={live.key} className="glass rounded-2xl p-3" aria-label={liveTitle(live)}>
                    <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <button type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => toggle(current, live.key))}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left">
                        <ChevronDown aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0 text-ink-subtle transition-transform', isCollapsed && '-rotate-90')} />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-ink">{liveTitle(live)}</span>
                          <span className="block text-xs text-ink-subtle">
                            {liveSpan(live)} · {plural(live.entries.length, 'part')} · {plural(clips, 'clip')}{cost > 0 ? ` · ${formatUsd(cost)}` : ''}
                          </span>
                        </span>
                      </button>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" icon={<FileText className="h-3.5 w-3.5" />} onClick={() => void openLiveTranscript(live)}>
                          Transcript
                        </Button>
                        <Button size="sm" variant={parts ? 'secondary' : 'ghost'} icon={<List className="h-3.5 w-3.5" />}
                          aria-pressed={parts} onClick={() => setShowParts((current) => toggle(current, live.key))}>
                          Parts
                        </Button>
                      </div>
                    </header>
                    {!isCollapsed && (
                      <div className="mt-3">
                        {parts ? runList(live.entries, labels) : <LiveClipsTable runDirs={live.entries.map((entry) => entry.outputDir)} limit={8} />}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        ))}
        {others.length > 0 && (
          <section aria-label="Other videos">
            {channels.length > 0 && (
              <h2 className="mb-3 flex items-center gap-2.5 text-base font-semibold text-ink">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.06] text-ink-muted"><Clapperboard className="h-3 w-3" /></span>
                Other videos
                <span className="text-xs font-normal text-ink-subtle">{plural(others.length, 'video')}</span>
              </h2>
            )}
            {runGrid(others)}
          </section>
        )}
      </div>
    )
  }

  if (open) {
    return (
      <ClipList
        output={open.output}
        outputDir={open.entry.outputDir}
        onNavigate={onNavigate}
        leading={<BackLink label="Library" onClick={() => setOpen(null)} />}
      />
    )
  }

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Studio"
        title="Library"
        description={
          entries && entries.length > 0
            ? `${plural(entries.length, 'run')} · ${plural(totalClips, 'clip')}`
            : 'Every run you finish lands here.'
        }
        actions={
          <>
            <Button variant="ghost" icon={<ListVideo className="h-4 w-4" />} onClick={() => onNavigate('jobs')}>
              Jobs
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              title="Refresh"
              onClick={load}
              disabled={refreshing}
              icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
            />
            {outputDirectory && (
              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => getApi().shell.openPath(outputDirectory)}>
                Open folder
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}

      {entries && entries.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <TextInput
            className="max-w-sm flex-1 rounded-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search videos and channels"
            leading={<Search className="h-3.5 w-3.5" />}
            aria-label="Search the library"
          />
          <Segmented
            size="sm"
            label="Library view"
            value={view}
            onChange={chooseView}
            options={[
              { value: 'lives', label: <span className="flex items-center gap-1.5"><Radio className="h-3.5 w-3.5" />Lives</span> },
              { value: 'grid', label: <span className="flex items-center gap-1.5"><LayoutGrid className="h-3.5 w-3.5" />Grid</span> },
              { value: 'list', label: <span className="flex items-center gap-1.5"><List className="h-3.5 w-3.5" />List</span> }
            ]}
          />
        </div>
      )}

      <div className="mt-5">
        {entries === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" aria-busy="true" aria-label="Loading library">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-1.5">
                <Skeleton className="aspect-video rounded-xl" />
                <div className="space-y-2.5 px-2 pb-2 pt-3.5">
                  <Skeleton className="h-3.5 w-3/4 rounded-full" />
                  <Skeleton className="h-3 w-1/3 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Clapperboard />}
            title="No clips yet"
            description="Generate clips from a long video and every run will show up here, newest first."
            action={
              <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={() => onNavigate('clip')}>
                Create your first clips
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <div className="glass flex flex-col items-center rounded-3xl px-5 py-10 text-center">
            <Search className="h-5 w-5 text-ink-subtle" />
            <p className="mt-3 text-sm text-ink-muted">Nothing matches “{query}”.</p>
          </div>
        ) : view === 'lives' ? renderLives() : view === 'list' ? runList(filtered) : runGrid(filtered)}
      </div>
      {liveTranscript && (
        <TranscriptDialog outputDir={liveTranscript.outputDir} output={liveTranscript.output} initialScope="live" onClose={() => setLiveTranscript(null)} />
      )}
    </Page>
  )
}

/** One run per line: a small thumbnail and the full title, date, clip count and cost. */
function RunRow({ entry, label, onOpen, onOpenFolder }: {
  entry: HistoryEntry
  /** Shown instead of the title (the title stays in the tooltip). */
  label?: string
  onOpen: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const failed = entry.status !== 'completed'
  const thumb = useRunThumbnail(failed ? null : entry.outputDir)
  const [previewFailed, setPreviewFailed] = useState(false)
  return (
    <div role="listitem" className="group flex items-center gap-3 border-b border-white/[0.05] px-2 py-1.5 last:border-b-0 hover:bg-white/[0.04]">
      <button type="button" onClick={failed ? onOpenFolder : onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={failed ? `Open folder for ${entry.status === 'incomplete' ? 'unfinished' : 'unreadable'} run` : `Open ${entry.videoTitle}`}>
        <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-black/40">
          {thumb && !previewFailed ? (
            <img src={localFileUrl(thumb)} alt="" draggable={false} className="h-full w-full object-contain" onError={() => setPreviewFailed(true)} />
          ) : failed ? (
            <div className="flex h-full items-center justify-center text-danger/70"><AlertTriangle className="h-4 w-4" /></div>
          ) : <Skeleton className="h-full rounded-none" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-ink">
            {failed ? `${entry.status === 'incomplete' ? 'Unfinished' : 'Unreadable'} run · Open folder` : label ?? entry.videoTitle}
          </p>
          <p className="mt-0.5 text-xs text-ink-subtle" title={entry.videoTitle}>{formatRelativeDate(entry.date)}</p>
        </div>
        {!failed && (
          <span className="w-20 shrink-0 text-right text-xs text-ink-muted">
            <span className="tabular text-ink">{entry.clipCount}</span> clip{entry.clipCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="w-16 shrink-0 text-right font-mono text-xs tabular text-ink-subtle">
          {entry.totalCostUsd != null ? formatUsd(entry.totalCostUsd) : ''}
        </span>
      </button>
      <Button size="sm" variant="ghost" iconOnly aria-label="Open folder" title="Open folder" onClick={onOpenFolder}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" icon={<FolderOpen className="h-3.5 w-3.5" />} />
    </div>
  )
}

function RunCard({ entry, label, onOpen, onOpenFolder }: {
  entry: HistoryEntry
  /** Shown instead of the title (the title stays in the tooltip). */
  label?: string
  onOpen: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const failed = entry.status !== 'completed'
  const thumb = useRunThumbnail(failed ? null : entry.outputDir)
  const [previewFailed, setPreviewFailed] = useState(false)

  return (
    <button
      onClick={failed ? onOpenFolder : onOpen}
      aria-label={failed ? `Open folder for ${entry.status === 'incomplete' ? 'unfinished' : 'unreadable'} run` : undefined}
      className={cn(
        'glass group rounded-2xl p-1.5 text-left transition-[transform,box-shadow] duration-300 ease-out',
        'hover:-translate-y-1 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_28px_56px_-24px_rgb(0_0_0/0.8)]'
      )}
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        {thumb && !previewFailed ? (
          <>
            {/* Vertical clips sit on a blurred copy of themselves to fill the 16:9 frame. */}
            <img src={localFileUrl(thumb)} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl saturate-150" />
            <img
              src={localFileUrl(thumb)}
              alt=""
              draggable={false}
              className="relative h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.04]"
              onError={() => setPreviewFailed(true)}
            />
          </>
        ) : failed ? (
          <div className="flex h-full items-center justify-center text-danger/70">
            <AlertTriangle className="h-6 w-6" />
          </div>
        ) : (
          <Skeleton className="h-full rounded-none" />
        )}
        {!failed && (
          <span className="glass-chip absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-2xs font-medium text-white">
            <Clapperboard className="h-3 w-3" />
            {entry.clipCount} clip{entry.clipCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="px-2 pb-2 pt-3.5">
        <p className="truncate text-sm font-medium text-ink" title={entry.videoTitle}>
          {failed ? `${entry.status === 'incomplete' ? 'Unfinished' : 'Unreadable'} run · Open folder` : label ?? entry.videoTitle}
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-subtle">
          <span>{formatRelativeDate(entry.date)}</span>
          {entry.totalCostUsd != null && (
            <>
              <span className="text-ink-faint">·</span>
              <span className="font-mono tabular">{formatUsd(entry.totalCostUsd)}</span>
            </>
          )}
        </p>
      </div>
    </button>
  )
}

/** Thumbnail of a run's best clip, loaded through the shared thumbnail queue. */
function useRunThumbnail(outputDir: string | null): string | null {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    setThumb(null)
    if (!outputDir) return
    let cancelled = false
    getApi()
      .history.getJob(outputDir)
      .then((raw) => {
        const output = parseJobOutput(raw)
        const best = output?.clips.reduce<JobOutput['clips'][number] | null>(
          (top, c) => (!top || c.virality_score > top.virality_score ? c : top),
          null
        )
        if (!best || cancelled) return null
        return loadThumbnail(clipFilePath(best.s3_url), best.duration_ms > 0 ? best.duration_ms / 2000 : undefined)
      })
      .then((path) => {
        if (!cancelled && path) setThumb(path)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [outputDir])
  return thumb
}
