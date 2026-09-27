'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock } = require('./support/mock-posts.cjs')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')

const KEY = 'automation-interval-key'
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'

function makeClip(file, color) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:d=4:r=15`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'mpeg4', '-q:v', '8',
    '-c:a', 'aac', '-movflags', '+faststart', file])
  return file
}

test('continuous schedules are validated and due only after their interval', () => {
  const { intervalDue, isAutomationSchedule, scheduleOf } = loadMain("export * from './src/shared/automations'", { electron: {} })
  assert.ok(isAutomationSchedule({ mode: 'slots' }))
  assert.ok(isAutomationSchedule({ mode: 'interval', minutes: 15 }))
  for (const bad of [null, {}, { mode: 'slots', minutes: 5 }, { mode: 'interval', minutes: 4 }, { mode: 'interval', minutes: 1441 },
    { mode: 'interval', minutes: 7.5 }, { mode: 'interval' }]) assert.equal(isAutomationSchedule(bad), false, JSON.stringify(bad))
  assert.deepEqual(scheduleOf({}), { mode: 'slots' }, 'automations saved before this feature keep daily times')

  const now = Date.parse('2026-09-27T20:00:00Z')
  const base = { enabled: true, schedule: { mode: 'interval', minutes: 15 }, accounts: [], lastRunAt: null,
    content: [{ id: 'a', status: 'queued' }] }
  assert.equal(intervalDue(base, now), true)
  assert.equal(intervalDue({ ...base, lastRunAt: new Date(now - 10 * 60_000).toISOString() }, now), false)
  assert.equal(intervalDue({ ...base, lastRunAt: new Date(now - 15 * 60_000).toISOString() }, now), true)
  assert.equal(intervalDue(base, now, now - 60_000), false, 'a recent failed attempt waits a full interval')
  assert.equal(intervalDue({ ...base, enabled: false }, now), false)
  assert.equal(intervalDue({ ...base, schedule: { mode: 'slots' } }, now), false)
  assert.equal(intervalDue({ ...base, content: [{ id: 'a', status: 'posted' }] }, now), false, 'nothing to post')
  assert.equal(intervalDue({ ...base, accounts: [{ platform: 'tiktok', accountId: 'x' }] }, now), false, 'TikTok clips wait for review')
})

test('a continuous automation posts one clip per interval without daily times', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-interval-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  try {
    const library = path.join(dir, 'library')
    const clips = [makeClip(path.join(library, 'clip_01.mp4'), 'blue'), makeClip(path.join(library, 'clip_02.mp4'), 'red')]
    const { electron } = fakeElectron(dir)
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"
    const main = loadMain(source, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', customVocabulary: '' })
    const [profile] = mock.state.profiles
    const youtube = mock.addAccount('youtube', profile._id, { username: 'channel' })
    const [created] = main.automations.createAutomation('Live clips')
    const update = { name: 'Live clips', enabled: true, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: [],
      youtubeVisibility: 'unlisted', youtubeMadeForKids: false, accounts: [{ platform: 'youtube', accountId: youtube._id }] }

    await assert.rejects(main.automations.updateAutomation(created.id, update), /at least one daily time/)
    await assert.rejects(main.automations.updateAutomation(created.id, { ...update, schedule: { mode: 'interval', minutes: 2 } }), /every 5 minutes/)
    await assert.rejects(main.automations.updateAutomation(created.id, { ...update, accounts: [], schedule: { mode: 'interval', minutes: 15 } }), /before enabling/)
    await main.automations.updateAutomation(created.id, { ...update, schedule: { mode: 'interval', minutes: 15 } })
    await main.automations.updateAutomation(created.id, { ...update, name: 'Renamed' })
    assert.deepEqual(main.automations.listAutomations()[0].schedule, { mode: 'interval', minutes: 15 }, 'an update without a schedule keeps it')

    await main.automations.addAutomationContent(created.id, clips)
    await main.automations.runAutomation(created.id, 'interval')
    assert.equal(posting.state.creates.length, 1)
    await main.automations.runAutomation(created.id, 'interval')
    assert.equal(posting.state.creates.length, 1, 'the second clip waits for the interval')
    assert.deepEqual(main.automations.listAutomations()[0].content.map((item) => item.status), ['posted', 'queued'])

    // Fifteen minutes later (after a restart), the next clip is due.
    const dataFile = fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-[a-f0-9]{64}\.json$/.test(name))
    const dataPath = path.join(dir, 'userData', dataFile)
    const stored = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    assert.equal(stored.version, 3, 'the file format is unchanged: older versions can still read it')
    stored.automations[0].lastRunAt = new Date(Date.now() - 16 * 60_000).toISOString()
    fs.writeFileSync(dataPath, JSON.stringify(stored))
    const restarted = loadMain(source, { electron })
    await restarted.automations.runAutomation(created.id, 'interval')
    assert.equal(posting.state.creates.length, 2)
    assert.deepEqual(restarted.automations.listAutomations()[0].content.map((item) => item.status), ['posted', 'posted'])

    await restarted.automations.updateAutomation(created.id, { ...update, enabled: false, schedule: { mode: 'interval', minutes: 15 } })
    await restarted.automations.addAutomationContent(created.id, [clips[0]])
    stored.automations[0].lastRunAt = null
    await restarted.automations.runAutomation(created.id, 'interval')
    assert.equal(posting.state.creates.length, 2, 'a disabled automation does not post on its interval')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    await mock.close()
    cleanup()
  }
})
