import { BrowserWindow, session, type Session } from 'electron'
import type { LiveChannel } from '../../shared/live'
import { getLiveChannel } from './live-channels'

/**
 * Watch a followed channel inside BridgeClip. The platform's own page runs in a
 * separate window and session: no preload, no app API, every permission
 * denied, and navigation kept on that platform's sites.
 */
const PARTITION = 'persist:live-player'
const players = new Map<string, BrowserWindow>()
let playerSession: Session | null = null

const PLATFORM_HOSTS: Record<LiveChannel['platform'], string[]> = {
  twitch: ['twitch.tv'],
  kick: ['kick.com'],
  youtube: ['youtube.com']
}

export function watchUrl(channel: Pick<LiveChannel, 'platform' | 'url'>): string {
  return channel.platform === 'youtube' ? `${channel.url}/live` : channel.url
}

export function isPlayerNavigation(channel: Pick<LiveChannel, 'platform'>, value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return PLATFORM_HOSTS[channel.platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

function isolatedSession(): Session {
  if (playerSession) return playerSession
  playerSession = session.fromPartition(PARTITION)
  playerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  playerSession.setPermissionCheckHandler(() => false)
  return playerSession
}

export function openLivePlayer(channelId: unknown): void {
  const channel = getLiveChannel(channelId)
  const existing = players.get(channel.id)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const window = new BrowserWindow({
    width: 1024,
    height: 640,
    minWidth: 480,
    minHeight: 300,
    title: `${channel.displayName} — Live`,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      session: isolatedSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })
  players.set(channel.id, window)
  window.on('closed', () => { if (players.get(channel.id) === window) players.delete(channel.id) })
  const contents = window.webContents
  contents.on('will-navigate', (event, url) => { if (!isPlayerNavigation(channel, url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!isPlayerNavigation(channel, url)) event.preventDefault() })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  // Third-party pages and their ads must not open windows or browser tabs.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void window.loadURL(watchUrl(channel))
}

export function closeLivePlayers(): void {
  for (const window of players.values()) if (!window.isDestroyed()) window.close()
  players.clear()
}
