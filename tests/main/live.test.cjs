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
  assert.deepEqual(canonicalLiveChannel('https://www.kick.com/Some-Streamer/'), { platform: 'kick', url: 'https://kick.com/some-streamer' })
  assert.deepEqual(canonicalLiveChannel('https://m.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa'),
    { platform: 'youtube', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' })
  for (const url of ['http://twitch.tv/a', 'https://twitch.tv/videos', 'https://twitch.tv/a/b', 'https://twitch.tv.evil.test/a',
    'https://u:p@twitch.tv/a', 'https://twitch.tv:8443/a', 'https://www.youtube.com/watch?v=x', 'https://www.youtube.com/@x',
    'https://example.com/@handle', 'https://kick.com/categories', 'https://kick.com/a/videos/1', 'https://kick.com.evil.test/a1', 'nope', 42]) {
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
  assert.deepEqual(first.decisions.map((item) => [item.clip.clip_index, item.decision]), [[0, 'kept'], [2, 'kept'], [1, 'low_score']])
  // The next chunk starts 510 s in with a 90 s lead-in: its clip at 0–40 s is 510–550 s on the stream.
  const second = selectLiveClips([clip(0, 5, 45, 0.95), clip(1, 300, 330, 0.75)],
    { streamOffsetSeconds: 510 }, [{ start: 515, end: 552, keptAt: now - 1000 }], { minScore: 0.7, maxPostsPerHour: 4, now })
  assert.deepEqual(second.indices, [1], 'the moment already kept from the previous chunk is a duplicate')
  assert.equal(second.decisions[0].decision, 'duplicate')
  const capped = selectLiveClips([clip(0, 0, 30, 0.9), clip(1, 60, 90, 0.95)], { streamOffsetSeconds: 0 },
    [{ start: -500, end: -470, keptAt: now - 10 * 60_000 }], { minScore: 0, maxPostsPerHour: 2, now })
  assert.deepEqual(capped.indices, [1], 'the best clip wins the last slot this hour')
  assert.equal(capped.decisions[1].decision, 'hourly_limit')
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

test('a check requested during another check runs right after it', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-recheck-')
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
    main.addLiveChannel({ ...main.DEFAULT_LIVE_CHANNEL, url: 'https://twitch.tv/first' })
    const first = main.checkLiveChannels()
    await until(() => spawned.length === 1, 'first probe')
    main.addLiveChannel({ ...main.DEFAULT_LIVE_CHANNEL, url: 'https://twitch.tv/second' })
    await main.checkLiveChannels() // returns at once: a check is running
    assert.equal(spawned.length, 1)
    spawned[0].child.stdout.end()
    spawned[0].child.emit('close', 0, null)
    await first
    await until(() => spawned.length === 2 && spawned[1].child.input.includes('\n'), 'follow-up probe')
    assert.deepEqual(JSON.parse(spawned[1].child.input).channels, ['https://www.twitch.tv/first', 'https://www.twitch.tv/second'])
    spawned[1].child.stdout.end()
    spawned[1].child.emit('close', 0, null)
    main.stopAllLiveForQuit()
  } finally { cleanup() }
})

test('recording progress is shown only when well formed and cleared at the end', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-progress-')
  try {
    const { session, spawned, states } = sessionHarness(dir)
    session.start()
    const { child } = spawned[0]
    child.send({ type: 'progress', part: 2, recorded_s: 125.5, part_s: 600, gaps: 1, ads: 15 })
    await until(() => states.at(-1)?.recording, 'progress')
    assert.deepEqual(states.at(-1).recording, { part: 2, seconds: 125.5, targetSeconds: 600, gaps: 1, ads: 15 })
    for (const bad of [{ part: 0 }, { recorded_s: -1 }, { part_s: 0 }, { ads: 1.5 }, { gaps: 'x' }]) {
      child.send({ type: 'progress', part: 3, recorded_s: 1, part_s: 600, gaps: 0, ads: 0, ...bad })
    }
    child.send({ type: 'stream_ended', reason: 'ended' })
    child.emit('close', 0, null)
    await until(() => states.at(-1)?.endedAt, 'end')
    assert.ok(states.every((state) => !state.recording || state.recording.part === 2), 'malformed progress is ignored')
    assert.equal(states.at(-1).recording, null)
  } finally { cleanup() }
})

test('the player opens the channel page and stays on its platform', () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-player-')
  try {
    const { watchUrl, isPlayerNavigation } = loadMain("export * from './src/main/live/live-player'", { electron: fakeElectron(dir).electron })
    assert.equal(watchUrl({ platform: 'youtube', url: 'https://www.youtube.com/@news' }), 'https://www.youtube.com/@news/live')
    assert.equal(watchUrl({ platform: 'kick', url: 'https://kick.com/name' }), 'https://kick.com/name')
    assert.ok(isPlayerNavigation({ platform: 'twitch' }, 'https://www.twitch.tv/other'))
    assert.ok(isPlayerNavigation({ platform: 'twitch' }, 'https://player.twitch.tv/?channel=x'))
    for (const url of ['https://twitch.tv.evil.test/', 'http://www.twitch.tv/x', 'https://kick.com/x', 'https://evil-twitch.tv/', 'javascript:alert(1)']) {
      assert.equal(isPlayerNavigation({ platform: 'twitch' }, url), false, url)
    }
  } finally { cleanup() }
})


test('the activity log says what the engine is doing and why each clip was kept or not', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-activity-')
  try {
    const { session, spawned, library, states } = sessionHarness(dir)
    session.start()
    const { child } = spawned[0]
    child.send({ type: 'status', status: 'recording', stream_started_at: Date.now() / 1000 - 2 * 3600 - 12 * 60 })
    child.send({ type: 'progress', part: 1, recorded_s: 10, part_s: 600, gaps: 0, ads: 3 })
    child.send({ type: 'progress', part: 1, recorded_s: 20, part_s: 600, gaps: 0, ads: 6 })
    child.send({ type: 'progress', part: 1, recorded_s: 40, part_s: 600, gaps: 2, ads: 6 })
    const job = randomUUID()
    child.send({ type: 'chunk_started', job_id: job, part: 1, stream_offset_s: 0, duration_s: 600, lead_in_s: 0 })
    child.send({ type: 'chunk_progress', part: 1, step: 'Downloading video...', percent: 5 })
    child.send({ type: 'chunk_progress', part: 1, step: 'Transcribing audio...', percent: 15 })
    child.send({ type: 'chunk_progress', part: 1, step: `Read C:${String.fromCharCode(92)}Users${String.fromCharCode(92)}me`, percent: 20 })
    child.send({ type: 'chunk_progress', part: 1, step: 'Fetched https://cdn.test/x', percent: 21 })
    child.send({ type: 'chunk_progress', part: 1, step: 'Rendered 1 of 2 clips', percent: 70 })
    await until(() => states.at(-1)?.clipping?.percent === 70, 'clipping progress')
    assert.deepEqual(states.at(-1).clipping, { part: 1, step: 'Rendered 1 of 2 clips', percent: 70 })
    writeRun(library, job, [[10, 50, 0.9], [100, 140, 0.4]])
    child.send({ type: 'chunk_done', job_id: job, part: 1, stream_offset_s: 0 })
    await until(() => states.at(-1)?.partsDone === 1, 'part done')
    assert.equal(states.at(-1).clipping, null)
    const lines = states.at(-1).activity.map((entry) => entry.text)
    assert.deepEqual(lines, [
      'Opening the stream',
      lines[1],
      'Twitch ad break: the stream is not sent during ads, so this time is skipped',
      'Ad break over: recording the stream again',
      '2 stream segment(s) could not be downloaded and were lost',
      lines[5],
      'Part 1: Transcribing audio',
      'Part 1: Rendered 1 of 2 clips',
      'Part 1: 2 clips made',
      '“Moment 0” · score 90 · kept (no automation linked)',
      '“Moment 1” · score 40 · not posted: score below 70'
    ])
    assert.match(lines[1], /^Live since .+ \(2 h 12 min ago\): recording from now on, the first 2 h 12 min are not recorded$/)
    assert.match(lines[5], /^Part 1 recorded \(10:00\) · about 2:12:0\d → 2:22:0\d into the stream: clipping it now$/)
    assert.ok(states.at(-1).streamStartedAt && states.at(-1).recordingStartedAt)
    assert.ok(states.at(-1).activity.every((entry) => !Number.isNaN(Date.parse(entry.at))))
  } finally { cleanup() }
})

test('chat activity is reported in the log without trusting chat text', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-chat-')
  try {
    const { session, spawned, states } = sessionHarness(dir)
    session.start()
    const { child } = spawned[0]
    child.send({ type: 'chat', state: 'connected' })
    child.send({ type: 'chat', state: 'connected' })
    child.send({ type: 'chat_summary', part: 1, messages: 1234, peak_s: 252, peak_count: 38, peak_reaction: 'KEKW' })
    child.send({ type: 'chat_summary', part: 2, messages: 9, peak_s: 10, peak_count: 3, peak_reaction: 'visit evil.test now' })
    child.send({ type: 'chat_summary', part: 3, messages: 0, timing: false })
    child.send({ type: 'chat', state: 'reconnecting' })
    await until(() => states.at(-1)?.activity.some((entry) => entry.text.startsWith('Chat connection lost')), 'chat lines')
    const lines = states.at(-1).activity.map((entry) => entry.text).slice(1)
    assert.deepEqual(lines, [
      'Reading the Twitch chat: reactions will help pick the moments',
      'Part 1: 1,234 chat messages · biggest reaction at 4:12 (38 messages, KEKW) · sent to the AI with the transcript',
      'Part 2: 9 chat messages · biggest reaction at 0:10 (3 messages) · sent to the AI with the transcript',
      "Part 3: chat not used (the platform did not time this part's video)",
      'Chat connection lost: reconnecting'
    ])
  } finally { cleanup() }
})

test('a run transcript and its chat are read from the library only', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-transcript-')
  try {
    const { getRunTranscript } = loadMain("export { getRunTranscript } from './src/main/file-manager'", { electron: fakeElectron(dir).electron })
    const library = path.join(dir, 'library')
    const run = path.join(library, 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ language: 'en', segments: [
      { start_time_ms: 5000, end_time_ms: 5700, text: "That's amazing.", speaker_label: 'S1' },
      { start_time_ms: 'x', end_time_ms: 1, text: 'bad' },
      { start_time_ms: 6000, end_time_ms: 7000, text: 'Next' }
    ] }))
    assert.deepEqual(await getRunTranscript(run, library), { language: 'en', chat: null, lines: [
      { start: 5, end: 5.7, text: "That's amazing.", speaker: 'S1' }, { start: 6, end: 7, text: 'Next', speaker: null }] })
    fs.writeFileSync(path.join(run, 'chat.json'), JSON.stringify({ version: 1, truncated: false, messages: [{ t: 1.5, text: 'KEKW' }, { t: 'bad' }] }))
    assert.deepEqual((await getRunTranscript(run, library)).chat, { messages: [{ t: 1.5, text: 'KEKW' }], truncated: false })
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'transcript.json'), JSON.stringify({ segments: [] }))
    assert.equal(await getRunTranscript(outside, library), null, 'a run outside the library is not read')
    assert.equal(await getRunTranscript(path.join(library, 'missing'), library), null)
  } finally { cleanup() }
})

test('the whole live transcript joins the parts of a session without their overlap', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-transcript-')
  try {
    const { getLiveTranscript, liveTranscriptText } = loadMain("export { getLiveTranscript, liveTranscriptText } from './src/main/file-manager'",
      { electron: fakeElectron(dir).electron })
    const library = path.join(dir, 'library')
    const session = randomUUID()
    const makePart = (part, offset, leadIn, lines, info = true, title = null) => {
      const run = path.join(library, randomUUID())
      fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ language: 'en', segments: lines.map(([s, text]) =>
        ({ start_time_ms: s * 1000, end_time_ms: s * 1000 + 900, text })) }))
      fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'x', source_video_title: title ?? `Streamer live 2026-09-27 14.17 (part ${part})`,
        source_video_duration_seconds: 600, total_clips: 0, clips: [] }))
      if (info) fs.writeFileSync(path.join(run, 'live.json'), JSON.stringify({ version: 1, sessionId: session, channelId: randomUUID(), channel: 'Streamer',
        platform: 'twitch', part, streamOffsetSeconds: offset, leadInSeconds: leadIn,
        recordingStartedAt: '2026-09-27T18:17:00.000Z', streamStartedAt: '2026-09-27T16:00:00.000Z' }))
      return run
    }
    const first = makePart(1, 0, 0, [[10, 'hello'], [590, 'end of one']])
    makePart(2, 510, 90, [[80, 'end of one'], [95, 'start of two']])
    makePart(4, 1530, 90, [[100, 'four']])
    makePart(1, 0, 0, [[5, 'other session']], false, 'Other live 2026-09-27 12.00 (part 1)')
    const live = await getLiveTranscript(first, library)
    assert.deepEqual(live.lines.map((line) => [line.t, line.part, line.text]), [[10, 1, 'hello'], [590, 1, 'end of one'], [605, 2, 'start of two'], [1630, 4, 'four']])
    assert.deepEqual(live.missingParts, [3])
    const text = liveTranscriptText(live)
    assert.match(text, /^Streamer — live transcript/)
    assert.match(text, /\[0:00:10 \/ 2:17:10\] hello/)

    // Parts recorded before live.json: grouped by title, offsets from durations and the fixed overlap.
    const old = path.join(dir, 'old')
    fs.mkdirSync(old)
    const oldLibrary = old
    const mk = (part, lines) => {
      const run = path.join(oldLibrary, randomUUID()); fs.mkdirSync(run)
      fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ segments: lines.map(([s, text]) => ({ start_time_ms: s * 1000, end_time_ms: s * 1000 + 500, text })) }))
      fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'x', source_video_title: `asmongold live 2026-09-27 14.17 (part ${part})`,
        source_video_duration_seconds: 600, total_clips: 0, clips: [] }))
      return run
    }
    const oldFirst = mk(1, [[1, 'a']])
    mk(2, [[50, 'overlap'], [100, 'b']])
    const merged = await getLiveTranscript(oldFirst, oldLibrary)
    assert.deepEqual(merged.lines.map((line) => [line.t, line.text]), [[1, 'a'], [610, 'b']])
    assert.equal(merged.sessionId, null)
  } finally { cleanup() }
})

test('replay links use exact broadcast time and only known replay pages', () => {
  const { isReplayUrl, replayLinkAt, secondsIntoStream, broadcastTime } = shared()
  assert.ok(isReplayUrl('https://www.twitch.tv/videos/2885452707', 'twitch'))
  assert.ok(isReplayUrl('https://www.youtube.com/watch?v=HvZt-nh9sGg', 'youtube'))
  assert.ok(isReplayUrl('https://kick.com/asmongold/videos/2cf5cde0-a637-4a02-992d-77a968941162', 'kick'))
  for (const [url, platform] of [['https://evil.test/videos/1', 'twitch'], ['https://www.twitch.tv/videos/1?x=javascript:', 'twitch'],
    ['https://www.youtube.com/watch?v=HvZt-nh9sGg', 'twitch'], ['http://www.twitch.tv/videos/1', 'twitch'], [42, 'kick']]) {
    assert.equal(isReplayUrl(url, platform), false, String(url))
  }
  assert.equal(replayLinkAt('https://www.twitch.tv/videos/1', 'twitch', 3723.9), 'https://www.twitch.tv/videos/1?t=1h2m3s')
  assert.equal(replayLinkAt('https://www.youtube.com/watch?v=HvZt-nh9sGg', 'youtube', 90), 'https://www.youtube.com/watch?v=HvZt-nh9sGg&t=90s')
  // Part time 45 s falls in the second span, after an ad gap: broadcast time comes from that span.
  const base = 1790532000
  const info = { streamStartedAt: new Date((base - 3600) * 1000).toISOString(), timeline: [[0, base, 40], [40, base + 100, 60]] }
  assert.equal(broadcastTime(info.timeline, 45), base + 105)
  assert.equal(secondsIntoStream(info, 45), 3705)
  assert.equal(secondsIntoStream({ ...info, timeline: [] }, 45), null)
})

test('a replay found after a part was saved is written to that part too', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-live-replay-')
  try {
    const { session, spawned, library, states } = sessionHarness(dir)
    session.start()
    const { child } = spawned[0]
    child.send({ type: 'status', status: 'recording', stream_started_at: 1790528400 })
    const job = randomUUID()
    const timeline = [[0, 1790532000, 300]]
    child.send({ type: 'chunk_started', job_id: job, part: 1, stream_offset_s: 0, duration_s: 300, lead_in_s: 0, timeline })
    writeRun(library, job, [[10, 50, 0.9]])
    child.send({ type: 'chunk_done', job_id: job, part: 1, stream_offset_s: 0, lead_in_s: 0, timeline })
    await until(() => states.at(-1)?.partsDone === 1, 'part done')
    const saved = () => JSON.parse(fs.readFileSync(path.join(library, job, 'live.json'), 'utf8'))
    assert.deepEqual(saved().timeline, timeline)
    assert.equal(saved().replayUrl, null)
    child.send({ type: 'replay', url: 'https://evil.test/videos/1' })
    child.send({ type: 'replay', url: 'https://www.twitch.tv/videos/2885452707' })
    await until(() => states.at(-1)?.replayUrl, 'replay')
    assert.equal(saved().replayUrl, 'https://www.twitch.tv/videos/2885452707')
    assert.ok(states.at(-1).activity.some((entry) => entry.text.startsWith('Replay found: twitch.tv/videos/2885452707')))
  } finally { cleanup() }
})
