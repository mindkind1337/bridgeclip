import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Play } from 'lucide-react'
import { streamClock, type LiveChannelClip } from '../../shared/live'
import { cn, errorMessage, formatTimecode } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { ClipPlayerDialog } from './ClipPlayerDialog'
import { Segmented } from './ui/Segmented'

/** All clips of one live at a glance: score, chat spike, part, time in the live, play and replay. */
export function LiveClipsTable({ runDirs, vertical = true }: { runDirs: string[]; vertical?: boolean }): React.JSX.Element {
  const [clips, setClips] = useState<LiveChannelClip[] | null>(null)
  const [order, setOrder] = useState<'score' | 'time'>('score')
  const [playing, setPlaying] = useState<LiveChannelClip | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = runDirs.join('|')

  useEffect(() => {
    let active = true
    setClips(null)
    getApi().history.liveClips(runDirs).then((result) => { if (active) setClips(result) })
      .catch((cause) => { if (active) { setError(errorMessage(cause, 'Could not load the clips.')); setClips([]) } })
    return () => { active = false }
    // Reload when the list of runs changes, not on every new array with the same runs.
  }, [key])

  const sorted = useMemo(() => [...(clips ?? [])].sort((a, b) => order === 'score'
    ? b.score - a.score : a.part - b.part || a.startSeconds - b.startSeconds), [clips, order])
  const spikes = (clips ?? []).filter((clip) => clip.chatReaction).length

  if (clips === null) return <p className="px-2 py-3 text-xs text-ink-subtle">Loading clips…</p>
  if (!clips.length) return <p className="px-2 py-3 text-xs text-ink-subtle">{error ?? 'No clips in this live.'}</p>
  return (
    <div className="glass overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2 text-2xs text-ink-muted">
        <span>{clips.length} clip{clips.length === 1 ? '' : 's'}{spikes ? ` · ${spikes} from a chat spike 🔥` : ''}</span>
        <Segmented size="sm" label="Order" value={order} onChange={setOrder}
          options={[{ value: 'score', label: 'Best first' }, { value: 'time', label: 'In order' }]} />
      </div>
      <table className="w-full text-xs">
        <thead className="sr-only"><tr><th>Play</th><th>Title</th><th>Score</th><th>Chat</th><th>Part</th><th>In the live</th><th>Replay</th></tr></thead>
        <tbody>
          {sorted.map((clip) => (
            <tr key={`${clip.runDir}-${clip.clipIndex}`} className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.03]">
              <td className="w-10 py-1.5 pl-2">
                <button type="button" onClick={() => setPlaying(clip)} aria-label={`Play “${clip.title}”`} title="Play here"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-ink-muted hover:bg-accent/20 hover:text-ink">
                  <Play className="ml-px h-3 w-3" fill="currentColor" />
                </button>
              </td>
              <td className="max-w-0 py-1.5 pr-2">
                <p className="truncate text-sm text-ink" title={clip.title}>{clip.title}</p>
                <p className="text-2xs text-ink-subtle">{formatTimecode(clip.durationMs)}</p>
              </td>
              <td className={cn('w-12 py-1.5 text-right font-mono tabular', clip.score >= 0.75 ? 'text-success' : 'text-ink-muted')} title="Score">
                {Math.round(clip.score * 100)}
              </td>
              <td className="w-32 py-1.5 pl-3 text-2xs text-warning">
                {clip.chatReaction && (
                  <span title={`Made from a chat spike: ${clip.chatReaction.count} messages in 10 s, ${clip.chatReaction.ratio.toFixed(1)} times the usual rate`}>
                    🔥 ×{clip.chatReaction.ratio.toFixed(1)}{clip.chatReaction.reaction ? ` ${clip.chatReaction.reaction}` : ''}
                  </span>
                )}
              </td>
              <td className="w-14 py-1.5 text-2xs text-ink-subtle">Part {clip.part}</td>
              <td className="w-24 py-1.5 text-right text-2xs text-ink-subtle">{clip.intoStream !== null ? streamClock(clip.intoStream) : ''}</td>
              <td className="w-9 py-1.5 pr-2 text-right">
                {clip.hasReplay && (
                  <button type="button" aria-label={`Watch “${clip.title}” in the replay`} title="Open the replay at this moment"
                    className="text-ink-subtle hover:text-accent-hover"
                    onClick={() => { setError(null); void getApi().live.openReplay(clip.runDir, clip.startSeconds).catch((cause) => setError(errorMessage(cause, 'Could not open the replay.'))) }}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert" className="px-3 py-1.5 text-2xs text-warning">{error}</p>}
      {playing && <ClipPlayerDialog filePath={playing.clipPath} title={playing.title} vertical={vertical} onClose={() => setPlaying(null)} />}
    </div>
  )
}
