import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MAX_LIVE_CHANNELS, parseLiveChannelInput, type LiveChannel } from '../../shared/live'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STORE_BYTES = 1024 * 1024
const VERSION = 1

let cached: LiveChannel[] | null = null

function dataPath(): string { return join(app.getPath('userData'), 'live-channels.json') }

function validChannel(value: unknown): value is LiveChannel {
  if (!value || typeof value !== 'object') return false
  const channel = value as LiveChannel
  if (!UUID.test(channel.id) || typeof channel.createdAt !== 'string' || !Number.isFinite(Date.parse(channel.createdAt))) return false
  try {
    const parsed = parseLiveChannelInput(channel)
    return parsed.url === channel.url && parsed.platform === channel.platform && parsed.displayName === channel.displayName
  } catch { return false }
}

function load(): LiveChannel[] {
  if (cached) return cached
  const path = dataPath()
  if (!existsSync(path)) return (cached = [])
  const file = statSync(path)
  if (!file.isFile() || file.size > MAX_STORE_BYTES) throw new Error('Live channel data could not be read. The file was preserved for recovery.')
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; channels?: unknown }
    if (record.version !== VERSION || !Array.isArray(record.channels) || record.channels.length > MAX_LIVE_CHANNELS ||
        !record.channels.every(validChannel)) throw new Error('Invalid live channel data')
    return (cached = record.channels)
  } catch {
    throw new Error('Live channel data could not be read. The file was preserved for recovery.')
  }
}

function save(channels: LiveChannel[]): void {
  const path = dataPath()
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: VERSION, channels }), { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
  cached = channels
}

export function listLiveChannels(): LiveChannel[] {
  return load().map((channel) => structuredClone(channel))
}

export function getLiveChannel(id: unknown): LiveChannel {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid channel')
  const channel = load().find((item) => item.id === id)
  if (!channel) throw new Error('Channel not found')
  return structuredClone(channel)
}

export function addLiveChannel(input: unknown): LiveChannel[] {
  const parsed = parseLiveChannelInput(input)
  const channels = load()
  if (channels.length >= MAX_LIVE_CHANNELS) throw new Error(`You can follow up to ${MAX_LIVE_CHANNELS} channels.`)
  if (channels.some((item) => item.url === parsed.url)) throw new Error('This channel is already in the list.')
  save([...channels, { ...parsed, id: randomUUID(), createdAt: new Date().toISOString() }])
  return listLiveChannels()
}

export function updateLiveChannel(id: unknown, input: unknown): LiveChannel[] {
  const current = getLiveChannel(id)
  const parsed = parseLiveChannelInput(input)
  const channels = load()
  if (channels.some((item) => item.id !== current.id && item.url === parsed.url)) throw new Error('This channel is already in the list.')
  save(channels.map((item) => item.id === current.id ? { ...parsed, id: item.id, createdAt: item.createdAt } : item))
  return listLiveChannels()
}

export function removeLiveChannel(id: unknown): LiveChannel[] {
  const current = getLiveChannel(id)
  save(load().filter((item) => item.id !== current.id))
  return listLiveChannels()
}

/** Tests only: forget the in-memory copy. */
export function resetLiveChannelCache(): void { cached = null }
