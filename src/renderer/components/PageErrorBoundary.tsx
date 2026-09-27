import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from './ui/Button'

/**
 * Keeps a page error from blanking the whole window: the sidebar stays usable,
 * and the page shows what failed with a way to reload it. Background work in
 * the main process (jobs, live recordings) is not affected by a page error.
 */
export class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page failed', error, info.componentStack)
  }

  componentDidUpdate(previous: { resetKey: string }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto mt-16 max-w-md px-6 text-center" role="alert">
        <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
        <h2 className="mt-3 text-sm font-semibold text-ink">This page could not be shown</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Recordings and jobs keep running. If BridgeClip was just updated, restart it; otherwise reload the window.
        </p>
        <p className="mt-2 break-words font-mono text-2xs text-ink-subtle">{this.state.error.message.slice(0, 300)}</p>
        <Button size="sm" className="mt-4" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => window.location.reload()}>Reload window</Button>
      </div>
    )
  }
}
