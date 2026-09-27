'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { randomUUID } = require('node:crypto')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const shared = () => loadMain("export * from './src/shared/live'", { electron: {} })

test('channel links are canonical and match the engine rules', () => {
  const { canonicalLiveChannel } = shared()
  assert.deepEqual(canonicalLiveChannel('https://twitch.tv/Streamer_1/'), { platform: 'twitch', url: 'https://www.twitch.tv/streamer_1' })
  assert.deepEqual(canonicalLiveChannel('https://www.youtube.com/@Some.Channel/live'), { platform: 'youtube', url: 'https://www.youtube.com/@Some.Channel' })
  assert.deepEqual(canonicalLiveChannel('https://m.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa'),
    { platform: 'youtube', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' })
  for (const url of ['http://twitch.tv/a', 'https://twitch.tv/videos', 'https://twitch.tv/a/b', 'https://twitch.tv.evil.test/a',
    'https://u:p@twitch.tv/a', 'https://twitch.tv:8443/a', 'https://www.youtube.com/watch?v=x', 'https://www.youtube.com/@x',
    'https://example.com/@handle', 'nope', 42]) {
    assert.equal(canonicalLiveChannel(url), null, String(url))
  }
})

test('channel settings are validated and normalized', () => {
  const { parseLiveChannelInput, DEFAULT_LIVE_CHANNEL } = shared()
  const input = { ...DEFAULT_LIVE_CHANNEL, url: 'https://twitch.tv/Streamer' }
  const parsed = parseLiveChannelInput(input)
  assert.equal(parsed.url, 'https://www.twitch.tv/streamer')
  assert.equal(parsed.displayName, 'streamer')
  assert.equal(parseLiveChannelInput({ ...input, displayName: '  My streamer ' }).displayName, 'My streamer')
  const bad = [
    { url: 'https://example.com' }, { enabled: 'yes' }, { automationId: 'not-a-uuid' }, { minScore: 1.5 },
    { maxClipsPerChunk: 0 }, { maxPostsPerHour: 13 }, { chunkMinutes: 4 }, { chunkMinutes: 7.5 },
    { clip: { ...DEFAULT_LIVE_CHANNEL.clip, durationRanges: [] } },
    { clip: { ...DEFAULT_LIVE_CHANNEL.clip, durationRanges: ['feature'] } },
    { clip: { ...DEFAULT_LIVE_CHANNEL.clip, clippingMode: 'advanced' } },
    { displayName: 'x'.repeat(81) }
  ]
  for (const change of bad) assert.throws(() => parseLiveChannelInput({ ...input, ...change }), undefined, JSON.stringify(change))
})

test('clip selection filters by score, removes overlap duplicates and caps posts per hour', () => {
  const { selectLiveClips } = shared()
  const clip = (index, start, end, score) => ({ clip_index: index, start_time_ms: start * 1000, end_time_ms: end * 1000, virality_score: score })
  const now = Date.parse('2026-09-27T20:00:00Z')
  const first = selectLiveClips([clip(0, 10, 50, 0.9), clip(1, 100, 140, 0.6), clip(2, 200, 240, 0.8)],
    { streamOffsetSeconds: 0 }, [], { minScore: 0.7, maxPostsPerHour: 4, now })
  assert.deepEqual(first.indices, [0, 2])
  // The next chunk starts 510 s in with a 90 s lead-in: its clip at 0–40 s is 510–550 s on the stream.
  const second = selectLiveClips([clip(0, 5, 45, 0.95), clip(1, 300, 330, 0.75)],
    { streamOffsetSeconds: 510 }, [{ start: 515, end: 552, keptAt: now - 1000 }], { minScore: 0.7, maxPostsPerHour: 4, now })
  assert.deepEqual(second.indices, [1], 'the moment already kept from the previous chunk is a duplicate')
  const capped = selectLiveClips([clip(0, 0, 30, 0.9), clip(1, 60, 90, 0.95)], { streamOffsetSeconds: 0 },
    [{ start: -500, end: -470, keptAt: now - 10 * 60_000 }], { minScore: 0, maxPostsPerHour: 2, now })
  assert.deepEqual(capped.indices, [1], 'the best clip wins the last slot this hour')
  const later = selectLiveClips([clip(0, 0, 30, 0.9)], { streamOffsetSeconds: 0 },
    [{ start: -500, end: -470, keptAt: now - 61 * 60_000 }], { minScore: 0, maxPostsPerHour: 1, now })
  assert.deepEqual(later.indices, [0], 'posts older than an hour no longer count')
})

test('channels persist atomically and reject duplicates', () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-channels-')
  try {
    const electron = fakeElectron(dir).electron
    const load = () => loadMain("export * from './src/main/live/live-channels'; export { DEFAULT_LIVE_CHANNEL } from './src/shared/live'", { electron })
    const main = load()
    const input = { ...main.DEFAULT_LIVE_CHANNEL, url: 'https://twitch.tv/streamer' }
    const [channel] = main.addLiveChannel(input)
    assert.throws(() => main.addLiveChannel({ ...input, url: 'https://www.twitch.tv/STREAMER' }), /already in the list/)
    main.updateLiveChannel(channel.id, { ...input, chunkMinutes: 15, displayName: 'Renamed' })
    const reloaded = load().listLiveChannels()
    assert.equal(reloaded.length, 1)
    assert.equal(reloaded[0].chunkMinutes, 15)
    assert.equal(reloaded[0].displayName, 'Renamed')
    assert.equal(reloaded[0].id, channel.id)
    const file = path.join(dir, 'userData', 'live-channels.json')
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [])
    fs.writeFileSync(file, '{"version":1,"channels":[{"id":"x"}]}')
    assert.throws(() => load().listLiveChannels(), /preserved for recovery/)
    fs.writeFileSync(file, JSON.stringify({ version: 1, channels: reloaded }))
    assert.deepEqual(load().removeLiveChannel(channel.id), [])
  } finally { cleanup() }
})

function fakeChildProcess() {
  const spawned = []
  const child_process = {
    ...require('node:child_process'),
    spawn: (command, args, options) => {
      const child = new EventEmitter()
      child.pid = 4242 + spawned.length
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.input = ''
      child.stdin.on('data', (data) => { child.input += data })
      child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
      spawned.push({ command, args, options, child })
      return child
    },
    execFile: (...args) => { const done = args.find((arg) => typeof arg === 'function'); done?.(null, '', ''); return new EventEmitter() }
  }
  return { child_process, spawned }
}

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function writeRun(library, jobId, clips) {
  const run = path.join(library, jobId)
  fs.mkdirSync(run, { recursive: true })
  const manifest = {
    job_id: jobId, source_video_title: 'streamer live (part 1)', total_clips: clips.length,
    clips: clips.map((clip, index) => {
      const file = path.join(run, `clip_0${index}.mp4`)
      fs.writeFileSync(file, 'clip')
      return { clip_index: index, s3_url: `file://${file}`, duration_ms: 30000, start_time_ms: clip[0] * 1000,
        end_time_ms: clip[1] * 1000, virality_score: clip[2], summary: `Moment ${index}` }
    })
  }
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(manifest))
}

function sessionHarness(dir, channelChanges = {}) {
  const { child_process, spawned } = fakeChildProcess()
  const main = loadMain(`
    export * from './src/main/live/live-session'
    export * as settings from './src/main/settings-store'
    export * as history from './src/main/run-history'
    export { DEFAULT_LIVE_CHANNEL } from './src/shared/live'
  `, { electron: fakeElectron(dir).electron, child_process })
  const library = path.join(dir, 'library')
  fs.mkdirSync(library, { recursive: true })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', customVocabulary: 'BridgeClip' })
  const channel = { ...main.DEFAULT_LIVE_CHANNEL, id: randomUUID(), url: 'https://www.twitch.tv/streamer', platform: 'twitch',
    displayName: 'streamer', createdAt: new Date().toISOString(), ...channelChanges }
  const states = []
  let exits = 0
  const session = new main.LiveSession(channel, (state) => states.push(state), () => { exits += 1 })
  return { main, session, spawned, library, states, exits: () => exits, channel }
}

test('a live session clips each part into the library and records its history', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-session-')
  try {
    const { main, session, spawned, library, states, exits } = sessionHarness(dir)
    session.start()
    assert.equal(spawned.length, 1)
    const { child, args, options } = spawned[0]
    assert.match(args[0], /bridge[\\/]live_runner\.py$/)
    assert.ok(options.env.BRIDGECLIP_WORK_ROOT)
    await until(() => child.input.includes('\n'), 'spec')
    const spec = JSON.parse(child.input.split('\n')[0])
    assert.equal(spec.mode, 'record')
    assert.equal(spec.session_id, session.sessionId)
    assert.equal(spec.channel_url, 'https://www.twitch.tv/streamer')
    assert.deepEqual([spec.chunk_seconds, spec.overlap_seconds, spec.max_clips_per_chunk], [600, 90, 2])
    assert.equal(spec.clip.output_dir, library)
    assert.equal(spec.clip.layout_vision_enabled, true)
    assert.deepEqual(spec.clip.keyterms, ['BridgeClip'])

    child.send({ type: 'status', status: 'recording' })
    const jobA = randomUUID()
    child.send({ type: 'chunk_started', job_id: jobA, part: 1, stream_offset_s: 0, duration_s: 600, lead_in_s: 0 })
    await until(() => main.history.readRunRecord(library, jobA)?.status === 'running', 'run record')
    assert.ok(main.activeLiveJobIds().has(jobA))
    writeRun(library, jobA, [[10, 50, 0.9], [100, 140, 0.5]])
    child.send({ type: 'chunk_done', job_id: jobA, part: 1, stream_offset_s: 0, clips: 2 })
    await until(() => states.at(-1)?.partsDone === 1, 'part done')
    assert.equal(main.history.readRunRecord(library, jobA).status, 'completed')
    assert.equal(states.at(-1).clipsMade, 2)
    assert.equal(states.at(-1).clipsQueued, 0, 'no automation linked: clips stay in the library')
    assert.ok(!main.activeLiveJobIds().has(jobA))

    const jobB = randomUUID()
    child.send({ type: 'chunk_started', job_id: jobB, part: 2, stream_offset_s: 510, duration_s: 600, lead_in_s: 90 })
    child.send({ type: 'chunk_done', job_id: 'not-a-uuid', part: 2, stream_offset_s: 510 })
    child.send('garbage')
    await until(() => main.history.readRunRecord(library, jobB)?.status === 'running', 'second record')
    child.emit('close', 1, null)
    await until(() => exits() === 1, 'exit')
    assert.equal(states.at(-1).status, 'error')
    assert.equal(states.at(-1).message, 'The live engine stopped unexpectedly.')
    assert.equal(main.history.readRunRecord(library, jobB).status, 'failed', 'an unfinished part is not left running')
  } finally { cleanup() }
})

test('clips are queued only when an automation is linked, and failures stay visible', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-queue-')
  try {
    const { session, spawned, library, states } = sessionHarness(dir, { automationId: randomUUID() })
    session.start()
    const { child } = spawned[0]
    const job = randomUUID()
    child.send({ type: 'chunk_started', job_id: job, part: 1, stream_offset_s: 0 })
    writeRun(library, job, [[10, 50, 0.9]])
    child.send({ type: 'chunk_done', job_id: job, part: 1, stream_offset_s: 0 })
    await until(() => states.at(-1)?.partsDone === 1, 'part done')
    // No Zernio workspace in this test: the automation cannot be reached.
    assert.match(states.at(-1).message, /^Clips were saved to the library but not queued/)
    assert.equal(states.at(-1).clipsQueued, 0)
  } finally { cleanup() }
})

test('stopping asks the engine to finish the current part, then ends cleanly', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-stop-')
  try {
    const { session, spawned, states, exits } = sessionHarness(dir)
    session.start()
    const { child } = spawned[0]
    child.send({ type: 'status', status: 'recording' })
    await until(() => states.at(-1)?.status === 'recording', 'recording')
    session.stop()
    assert.equal(states.at(-1).status, 'stopping')
    const stopFile = path.join(spawned[0].options.env.BRIDGECLIP_WORK_ROOT, `live-${session.sessionId}`, 'stop')
    await until(() => fs.existsSync(stopFile), 'stop file')
    child.send({ type: 'chunk_failed', part: 3, message: 'BridgeClip couldn\u2019t find any clips in this video.' })
    child.send({ type: 'stream_ended', reason: 'stopped', gaps: 0 })
    await until(() => states.at(-1)?.status === 'ended', 'ended')
    child.emit('close', 0, null)
    await until(() => exits() === 1, 'exit')
    assert.equal(states.at(-1).status, 'ended')
    assert.equal(states.at(-1).partsDone, 1)
    assert.ok(states.at(-1).endedAt)
  } finally { cleanup() }
})

test('engine messages with paths or links are replaced by safe text', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-safe-')
  try {
    const { session, spawned, states } = sessionHarness(dir)
    session.start()
    spawned[0].child.send({ type: 'error', message: 'failed at C:\\Users\\me\\secret https://x.test/?token=1' })
    await until(() => states.at(-1)?.status === 'error', 'error')
    assert.equal(states.at(-1).message, 'Live recording failed.')
  } finally { cleanup() }
})

test('the monitor probes enabled channels and starts a session for the live ones', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-monitor-')
  try {
    const { child_process, spawned } = fakeChildProcess()
    const main = loadMain(`
      export * from './src/main/live/live-monitor'
      export * from './src/main/live/live-channels'
      export * as settings from './src/main/settings-store'
      export { DEFAULT_LIVE_CHANNEL } from './src/shared/live'
    `, { electron: fakeElectron(dir).electron, child_process })
    fs.mkdirSync(path.join(dir, 'library'))
    main.settings.savePublicSettings({ outputDirectory: path.join(dir, 'library'), pythonPath: 'python3', customVocabulary: '' })
    main.settings.replaceApiKey('openrouterApiKey', 'or-key')
    const base = { ...main.DEFAULT_LIVE_CHANNEL }
    main.addLiveChannel({ ...base, url: 'https://twitch.tv/online' })
    main.addLiveChannel({ ...base, url: 'https://twitch.tv/offline' })
    main.addLiveChannel({ ...base, url: 'https://twitch.tv/paused', enabled: false })
    const updates = []
    main.startLiveMonitor((overview) => updates.push(overview))

    const checking = main.checkLiveChannels()
    await until(() => spawned.length === 1 && spawned[0].child.input.includes('\n'), 'probe')
    const probe = spawned[0].child
    assert.deepEqual(JSON.parse(probe.input).channels, ['https://www.twitch.tv/online', 'https://www.twitch.tv/offline'])
    probe.send({ type: 'probe', url: 'https://www.twitch.tv/online', live: true, title: 'Big\u0007 game', channel: 'Online' })
    probe.send({ type: 'probe', url: 'https://www.twitch.tv/offline', live: false })
    probe.send({ type: 'probe', url: 'https://www.twitch.tv/unknown', live: true })
    probe.stdout.end()
    probe.emit('close', 0, null)
    await checking

    assert.equal(spawned.length, 2, 'one recording session started')
    await until(() => spawned[1].child.input.includes('\n'), 'record spec')
    assert.equal(JSON.parse(spawned[1].child.input.split('\n')[0]).channel_url, 'https://www.twitch.tv/online')
    const overview = main.getLiveOverview()
    const online = overview.channels.find((channel) => channel.url.endsWith('/online'))
    assert.equal(overview.checks[online.id].title, 'Big  game')
    assert.equal(overview.sessions.length, 1)
    assert.equal(overview.sessions[0].status, 'resolving')
    assert.ok(updates.length > 0)

    const next = main.checkLiveChannels()
    await until(() => spawned.length === 3 && spawned[2].child.input.includes('\n'), 'second probe')
    assert.deepEqual(JSON.parse(spawned[2].child.input).channels, ['https://www.twitch.tv/offline'],
      'the next check probes only channels without a session')
    spawned[2].child.stdout.end()
    spawned[2].child.emit('close', 0, null)
    await next
    main.stopAllLiveForQuit()
  } finally { cleanup() }
})
