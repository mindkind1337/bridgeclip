import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Clapperboard, FileText, FolderOpen, LayoutGrid, List, ListVideo, Radio, RefreshCw, Search, Sparkles } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate, formatUsd, localFileUrl } from '../lib/utils'
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
import { Switch } from '../components/ui/Switch'
import { TranscriptDialog } from '../components/TranscriptDialog'
import { groupLibraryByLive, type LibraryLive } from '../../shared/live'
import type { Page as AppPage } from '../components/Sidebar'

type LibraryView = 'grid' | 'details'
const VIEW_STORAGE_KEY = 'bridgeclip.library.view'
const GROUP_STORAGE_KEY = 'bridgeclip.library.groupLives'

function savedGrouping(): boolean {
  try { return localStorage.getItem(GROUP_STORAGE_KEY) !== 'off' } catch { return true }
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const HOUR = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function liveLabel(live: LibraryLive<HistoryEntry>): string {
  const start = live.streamStartedAt ?? live.firstRecordedAt
  const date = new Date(start)
  const today = new Date().toDateString() === date.toDateString()
  return `${today ? 'Today' : DAY.format(date)} · ${live.streamStartedAt ? `live since ${HOUR.format(date)}` : `recorded from ${HOUR.format(date)}`}`
}

function savedView(): LibraryView {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'details' ? 'details' : 'grid' } catch { return 'grid' }
}

export function LibraryPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const [view, setView] = useState<LibraryView>(savedView)
  const [grouped, setGrouped] = useState(savedGrouping)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [liveTranscript, setLiveTranscript] = useState<{ outputDir: string; output: JobOutput } | null>(null)
  const chooseGrouping = (next: boolean): void => {
    setGrouped(next)
    try { localStorage.setItem(GROUP_STORAGE_KEY, next ? 'on' : 'off') } catch { /* A remembered choice is a convenience only. */ }
  }
  const chooseView = (next: LibraryView): void => {
    setView(next)
    try { localStorage.setItem(VIEW_STORAGE_KEY, next) } catch { /* A remembered view is a convenience only. */ }
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
    return q ? entries.filter((e) => e.videoTitle.toLowerCase().includes(q)) : entries
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

  /** Parts of one live are labeled by their order in it; other runs keep their title. */
  const renderRuns = (list: HistoryEntry[], labels?: Map<string, string>): React.JSX.Element => view === 'details' ? (
    <div className="glass overflow-hidden rounded-2xl" role="list" aria-label="Runs">
      {list.map((entry) => (
        <RunRow key={entry.jobId} entry={entry} label={labels?.get(entry.jobId)} onOpen={() => openRun(entry)} onOpenFolder={() => void openFolder(entry)} />
      ))}
    </div>
  ) : (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
      {list.map((entry) => (
        <RunCard key={entry.jobId} entry={entry} label={labels?.get(entry.jobId)} onOpen={() => openRun(entry)} onOpenFolder={() => void openFolder(entry)} />
      ))}
    </div>
  )

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

  const renderGroups = (): React.JSX.Element => {
    const { channels, others } = groupLibraryByLive(filtered)
    return (
      <div className="space-y-8">
        {channels.map((channel) => (
          <section key={channel.channel} aria-label={channel.channel}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
              <Radio aria-hidden className="h-4 w-4 text-danger" />{channel.channel}
              <span className="text-xs font-normal text-ink-subtle">
                {channel.lives.length} live{channel.lives.length === 1 ? '' : 's'} · {channel.lives.reduce((sum, live) => sum + live.entries.reduce((n, e) => n + e.clipCount, 0), 0)} clips
              </span>
            </h2>
            <div className="space-y-4">
              {channel.lives.map((live) => {
                const clips = live.entries.reduce((sum, entry) => sum + entry.clipCount, 0)
                const cost = live.entries.reduce((sum, entry) => sum + (entry.totalCostUsd ?? 0), 0)
                const isCollapsed = collapsed.has(live.key)
                const labels = new Map(live.entries.map((entry, index) =>
                  [entry.jobId, `Part ${index + 1} · recorded ${HOUR.format(new Date(entry.live!.recordedAt))}${entry.live!.part !== index + 1 ? ` (session part ${entry.live!.part})` : ''}`]))
                return (
                  <div key={live.key} className="rounded-2xl border border-white/[0.06] p-2">
                    <div className="flex flex-wrap items-center gap-2 px-1.5 pb-2">
                      <button type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => {
                        const next = new Set(current); if (next.has(live.key)) next.delete(live.key); else next.add(live.key); return next
                      })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-ink-subtle transition-transform', isCollapsed && '-rotate-90')} />
                        <span className="text-sm font-medium text-ink">{liveLabel(live)}</span>
                        <span className="text-xs text-ink-subtle">
                          {live.entries.length} part{live.entries.length === 1 ? '' : 's'} · {clips} clip{clips === 1 ? '' : 's'}{cost > 0 ? ` · ${formatUsd(cost)}` : ''}
                        </span>
                      </button>
                      <Button size="sm" variant="ghost" icon={<FileText className="h-3.5 w-3.5" />} onClick={() => void openLiveTranscript(live)}>
                        Transcript
                      </Button>
                    </div>
                    {!isCollapsed && renderRuns(live.entries, labels)}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
        {others.length > 0 && (
          <section aria-label="Other videos">
            {channels.length > 0 && <h2 className="mb-2 text-sm font-semibold text-ink">Other videos</h2>}
            {renderRuns(others)}
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
            ? `${entries.length} run${entries.length === 1 ? '' : 's'} · ${totalClips} clips`
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
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <TextInput
            className="max-w-sm flex-1 rounded-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by video title"
            leading={<Search className="h-3.5 w-3.5" />}
            aria-label="Search runs"
          />
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <Switch checked={grouped} onChange={chooseGrouping} label="Group lives" />
            Group lives
          </label>
          <Segmented
            size="sm"
            label="Library view"
            value={view}
            onChange={chooseView}
            options={[
              { value: 'grid', label: <span className="flex items-center gap-1.5"><LayoutGrid className="h-3.5 w-3.5" />Grid</span> },
              { value: 'details', label: <span className="flex items-center gap-1.5"><List className="h-3.5 w-3.5" />Details</span> }
            ]}
          />
        </div>
      )}

      <div className="mt-4">
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
            <p className="mt-3 text-sm text-ink-muted">No runs match “{query}”.</p>
          </div>
        ) : grouped ? renderGroups() : renderRuns(filtered)}
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
