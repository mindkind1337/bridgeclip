import { create } from 'zustand'
import { useMemo } from 'react'
import type { LiveChannel, LiveOverview, LiveSessionState } from '../../shared/live'

/** Live channels and sessions as the main process reports them; loaded at startup so every page can show recordings. */
interface LiveStore {
  overview: LiveOverview | null
  set: (overview: LiveOverview) => void
}

export const useLiveStore = create<LiveStore>((set) => ({
  overview: null,
  set: (overview) => set({ overview })
}))

export function isRecordingState(state: LiveSessionState | undefined): boolean {
  return Boolean(state && ['resolving', 'recording', 'stopping'].includes(state.status))
}

/** Sessions recording now, with their channel. */
export function useRecordings(): { channel: LiveChannel; state: LiveSessionState }[] {
  // Select the stored overview itself (a stable reference) and derive the list
  // outside the selector: a selector returning new objects re-renders forever.
  const overview = useLiveStore((store) => store.overview)
  return useMemo(() => {
    if (!overview) return []
    return overview.sessions.filter(isRecordingState).flatMap((state) => {
      const channel = overview.channels.find((item) => item.id === state.channelId)
      return channel ? [{ channel, state }] : []
    })
  }, [overview])
}
