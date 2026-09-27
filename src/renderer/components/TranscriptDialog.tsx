import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MessageSquare, Search, X } from 'lucide-react'
import type { JobOutput, RunTranscript } from '../../shared/job-output'
import { cn, errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { TextInput } from './ui/Field'
import { Segmented } from './ui/Segmented'

const MAX_SHOWN = 1500
const CHAT_WINDOW_SECONDS = 10

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const rest = `${String(Math.floor((whole % 3600) / 60)).padStart(hours ? 2 : 1, '0')}:${String(whole % 60).padStart(2, '0')}`
  return hours ? `${hours}:${rest}` : rest
}

/** The run's transcript, and for live parts its chat, with the passages that became clips marked. */
export function TranscriptDialog({ outputDir, output, onClose }: { outputDir: string; output: JobOutput; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [data, setData] = useState<RunTranscript | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'transcript' | 'chat'>('transcript')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); previous?.focus?.() }
  }, [])

  useEffect(() => {
    let active = true
    getApi().history.transcript(outputDir)
      .then((result) => { if (active) setData(result) })
      .catch((cause) => { if (active) { setError(errorMessage(cause, 'Could not read the transcript.')); setData(null) } })
    return () => { active = false }
  }, [outputDir])

  // Clip ranges on the source timeline, numbered by score like the clip list.
  const clips = useMemo(() => [...output.clips]
    .sort((a, b) => b.virality_score - a.virality_score)
    .map((clip, rank) => ({ rank: rank + 1, start: clip.start_time_ms / 1000, end: clip.end_time_ms / 1000, title: clip.summary })), [output])
  const clipAt = (start: number, end: number): number | null => clips.find((clip) => start < clip.end && end > clip.start)?.rank ?? null

  const needle = query.trim().toLowerCase()
  const lines = useMemo(() => (data?.lines ?? []).filter((line) => !needle || line.text.toLowerCase().includes(needle)), [data, needle])
  const messages = useMemo(() => (data?.chat?.messages ?? []).filter((item) => !needle || item.text.toLowerCase().includes(needle)), [data, needle])
  const activity = useMemo(() => {
    const all = data?.chat?.messages ?? []
    if (!all.length) return []
    const buckets = Array.from({ length: Math.floor(Math.max(...all.map((item) => item.t)) / CHAT_WINDOW_SECONDS) + 1 }, () => 0)
    for (const item of all) buckets[Math.floor(item.t / CHAT_WINDOW_SECONDS)] += 1
    return buckets
  }, [data])
  const peak = Math.max(1, ...activity)

  return (
    <Dialog ref={panel} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[860px] h-[80vh]">
      <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {tab === 'chat' ? 'Chat' : 'Transcript'} · {output.source_video_title || 'Untitled video'}
        </h2>
        <Button size="sm" variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X className="h-4 w-4" />} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        {data?.chat && (
          <Segmented size="sm" label="Show" value={tab} onChange={setTab}
            options={[{ value: 'transcript', label: 'Transcript' }, { value: 'chat', label: `Chat (${data.chat.messages.length.toLocaleString('en-US')})` }]} />
        )}
        <TextInput inputSize="sm" className="min-w-[200px] flex-1" aria-label="Search" placeholder="Search" value={query}
          leading={<Search className="h-3.5 w-3.5" />} onChange={(event) => setQuery(event.target.value)} />
        {clips.length > 0 && <span className="text-2xs text-ink-subtle">Highlighted: passages that became clips</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {data === undefined ? (
          <p className="py-8 text-center text-sm text-ink-muted">Loading…</p>
        ) : !data ? (
          <p role="alert" className="py-8 text-center text-sm text-ink-muted">{error ?? 'This run has no transcript. It may have had no speech, or was made before transcripts were kept.'}</p>
        ) : tab === 'transcript' ? (
          lines.length === 0 ? <p className="py-8 text-center text-sm text-ink-muted">No line matches.</p> : (
            <ol className="space-y-0.5">
              {lines.slice(0, MAX_SHOWN).map((line, index) => {
                const clip = clipAt(line.start, line.end)
                return (
                  <li key={`${line.start}-${index}`} className={cn('flex gap-3 rounded-lg px-2 py-1 text-sm leading-relaxed',
                    clip ? 'bg-accent/[0.08] shadow-[inset_2px_0_0_rgb(var(--accent))]' : '')}>
                    <span className="w-14 shrink-0 pt-0.5 font-mono text-2xs tabular text-ink-subtle">{clock(line.start)}</span>
                    <span className="min-w-0 flex-1 text-ink">
                      {line.speaker && <span className="mr-1.5 text-2xs text-ink-subtle">{line.speaker}</span>}
                      {line.text}
                    </span>
                    {clip && <span className="shrink-0 pt-0.5 text-2xs text-accent-hover">Clip {clip}</span>}
                  </li>
                )
              })}
              {lines.length > MAX_SHOWN && <li className="py-2 text-center text-2xs text-ink-subtle">Showing the first {MAX_SHOWN} lines. Search to find more.</li>}
            </ol>
          )
        ) : (
          <>
            {activity.length > 0 && (
              <div className="mb-3">
                <p className="mb-1 flex items-center gap-1.5 text-2xs text-ink-muted"><MessageSquare className="h-3 w-3" />Messages per {CHAT_WINDOW_SECONDS} s</p>
                <div className="flex h-16 items-end gap-px" role="img" aria-label="Chat activity over the part">
                  {activity.map((count, index) => {
                    const start = index * CHAT_WINDOW_SECONDS
                    const clip = clipAt(start, start + CHAT_WINDOW_SECONDS)
                    return (
                      <div key={index} title={`${clock(start)} · ${count} messages${clip ? ` · Clip ${clip}` : ''}`}
                        className={cn('min-w-[2px] flex-1 rounded-t-sm', clip ? 'bg-accent' : 'bg-white/25')}
                        style={{ height: `${Math.max(4, (count / peak) * 100)}%` }} />
                    )
                  })}
                </div>
              </div>
            )}
            {messages.length === 0 ? <p className="py-8 text-center text-sm text-ink-muted">No message matches.</p> : (
              <ol className="space-y-px">
                {messages.slice(0, MAX_SHOWN).map((item, index) => (
                  <li key={`${item.t}-${index}`} className={cn('flex gap-3 rounded px-2 py-0.5 text-xs',
                    clipAt(item.t, item.t + 0.01) ? 'bg-accent/[0.06]' : '')}>
                    <span className="w-14 shrink-0 font-mono text-2xs tabular text-ink-subtle">{clock(item.t)}</span>
                    <span className="min-w-0 flex-1 break-words text-ink-muted">{item.text}</span>
                  </li>
                ))}
                {(messages.length > MAX_SHOWN || data.chat?.truncated) && (
                  <li className="py-2 text-center text-2xs text-ink-subtle">Showing part of the chat. Search to find a message.</li>
                )}
              </ol>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
