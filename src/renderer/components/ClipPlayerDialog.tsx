import { useEffect, useId, useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'

/** Plays a clip inside BridgeClip, with sound and controls; the system player stays one click away. */
export function ClipPlayerDialog({ filePath, title, vertical, onClose }: {
  filePath: string
  title: string
  vertical: boolean
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  // A read can fail for a moment (file busy, seek aborted): reload a few times and resume where it stopped.
  const video = useRef<HTMLVideoElement>(null)
  const retries = useRef(0)
  const resumeAt = useRef(0)
  // The parent passes a new onClose each render; focus is taken and restored once.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [])

  const onError = (): void => {
    const element = video.current
    if (!element || retries.current >= 3) {
      setFailed(true)
      return
    }
    retries.current += 1
    resumeAt.current = element.currentTime
    element.load()
  }

  const onLoadedMetadata = (): void => {
    const element = video.current
    if (!element || resumeAt.current <= 0) return
    element.currentTime = resumeAt.current
    resumeAt.current = 0
    void element.play().catch(() => {})
  }

  const openExternally = (): void => {
    void getApi().shell.openPath(filePath).catch(() => {})
  }

  return (
    <Dialog ref={panel} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName={vertical ? 'max-w-[440px]' : 'max-w-[960px]'}>
      <div className="flex items-center gap-3 px-4 py-3">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</h2>
        <Button size="sm" variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X className="h-4 w-4" />} />
      </div>
      <div className="min-h-0 flex-1 bg-black">
        {failed ? (
          <p role="alert" className="px-4 py-10 text-center text-sm text-ink-muted">
            This clip cannot play here. Open it in your video player instead.
          </p>
        ) : (
          <video
            ref={video}
            src={localFileUrl(filePath)}
            controls
            autoPlay
            playsInline
            preload="auto"
            className="mx-auto max-h-[70vh] w-full bg-black"
            aria-label={`Play “${title}”`}
            onError={onError}
            onLoadedMetadata={onLoadedMetadata}
          />
        )}
      </div>
      <DialogFooter>
        <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={openExternally}>Open in video player</Button>
        <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
      </DialogFooter>
    </Dialog>
  )
}
