/**
 * A side chat must survive an app restart or a plugin reload. The agent dies
 * with the old run, but the session is on disk: the new run lists it under its
 * conversation (idle) and resumes it on the next message. Before this, the
 * first write of the new run replaced the record file with only its own live
 * chats, so every earlier side chat vanished from the panel.
 */
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { beforeEach, expect, test, vi } from 'vitest'

const home = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/dsh-side-chat-restore-test`)

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: (...parts: string[]) => [home, ...parts].join('/'),
}))
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: undefined }))

const { apply } = await import('../src/index.ts')

/** Sessions that exist "on disk" across runs. */
const disk = new Set<string>()

beforeEach(async () => {
  disk.clear()
  await rm(home, { recursive: true, force: true })
})

function makeAgent(id: string, log: string[]) {
  return {
    id,
    status: 'idle',
    options: {},
    session: { id },
    ctx: {},
    followup: () => { log.push(`followup:${id}`) },
    steer: () => { log.push(`steer:${id}`) },
    inject: vi.fn(),
    cancel: () => { log.push(`cancel:${id}`) },
    whenIdle: async () => {},
  }
}

/** One run of the plugin (a fresh `apply` over a fresh host). */
function mount() {
  const log: string[] = []
  const agents = new Map<string, any>()
  let route: any
  let unload: (() => void) | undefined

  agents.set('parent-1', {
    id: 'parent-1',
    status: 'idle',
    options: { provider: 'hyper', model: 'v4' },
    session: { header: { cwd: '/work' }, requestHeader: () => ({ config: { provider: 'hyper', model: 'v4' } }) },
    ctx: {},
    followup: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: async () => {},
  })

  const ctx: any = {
    fiber: { entry: { options: { id: 'side-chat-entry' } } },
    get: () => undefined,
    inject: () => {},
    effect: (callback: () => unknown, label?: string) => {
      if (label?.includes('re-archive')) return undefined
      const disposer = callback()
      if (label?.includes('dispose side chats') && typeof disposer === 'function') unload = disposer as () => void
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (options: any) => {
        const agent = makeAgent(options.sessionId, log)
        agents.set(options.sessionId, agent)
        disk.add(options.sessionId)
        options.setup?.({ on: () => {} })
        return { agent, dispose: async () => { agents.delete(options.sessionId) } }
      },
      resume: async (options: any) => {
        if (!disk.has(options.resumeSessionId)) throw new Error('no such session')
        log.push(`resume:${options.resumeSessionId}`)
        const agent = makeAgent(options.resumeSessionId, log)
        agents.set(options.resumeSessionId, agent)
        options.setup?.({ on: () => {} })
        return { agent, dispose: async () => { agents.delete(options.resumeSessionId) } }
      },
    },
    sessionQuery: {
      readSession: async (id: string) => {
        if (!disk.has(id)) throw new Error('not found')
        return { events: [] }
      },
    },
    workspaceRegistry: {
      archiveSession: async () => {},
      unarchiveSession: async () => {},
    },
    permissionPresets: { current: () => 'workspace-write', set: () => {} },
    agentPresets: { composeFrom: () => undefined },
    attachments: { imageLimits: { maxImagesPerMessage: 4 } },
    sessions: { get: () => undefined },
    webServer: { register: (registered: unknown) => { route = registered; return () => {} } },
  }

  apply(ctx)

  const call = async (method: string, payload: unknown = {}) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
    req.headers = { host: 'localhost' }
    req.method = 'POST'
    req.url = `/sidechat/api/${method}`
    let status: number | undefined
    let body: any
    await route.handler(req, {
      writeHead: (code: number) => { status = code },
      end: (chunk: string) => { body = JSON.parse(chunk) },
    })
    return { status, body }
  }

  return { call, log, unload: () => unload?.() }
}

/** Let the queued record writes (real file I/O) land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 100))

test('side chats from an earlier run stay listed and resume on their next message', async () => {
  const first = mount()
  const a = (await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'one' }] })).body.value.childId
  const b = (await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'two' }] })).body.value.childId
  await flush()
  first.unload()

  // The restart: a new run with no live side chats.
  const second = mount()
  const listed = await second.call('sidechat.list', { parentSessionId: 'parent-1' })
  expect(listed.body.value.items).toEqual([
    { childId: a, running: false },
    { childId: b, running: false },
  ])

  // A new side chat in the new run must not wipe the earlier ones from the record.
  const c = (await second.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'three' }] })).body.value.childId
  await flush()

  const sent = await second.call('sidechat.followup', { childId: a, content: [{ type: 'text', text: 'back again' }] })
  expect(sent.status).toBe(200)
  expect(second.log).toContain(`resume:${a}`)
  expect(second.log.indexOf(`followup:${a}`)).toBeGreaterThan(second.log.indexOf(`resume:${a}`))

  await flush()
  second.unload()
  const third = mount()
  const again = await third.call('sidechat.list', { parentSessionId: 'parent-1' })
  expect(again.body.value.items.map((i: { childId: string }) => i.childId)).toEqual([a, b, c])
})

test('ending a side chat from an earlier run forgets it; a deleted session is dropped', async () => {
  const first = mount()
  const a = (await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'one' }] })).body.value.childId
  const b = (await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'two' }] })).body.value.childId
  await flush()
  first.unload()
  disk.delete(b)

  const second = mount()
  expect((await second.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([{ childId: a, running: false }])
  // Stopping an idle dormant chat is a no-op, not an error.
  expect((await second.call('sidechat.stop', { childId: a })).status).toBe(200)
  expect((await second.call('sidechat.dispose', { childId: a })).status).toBe(200)
  await flush()
  expect((await second.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([])

  const third = mount()
  expect((await third.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([])
})

test('a side chat started from highlighted text is named after it, across a restart', async () => {
  const first = mount()
  const quoted = (await first.call('sidechat.start', {
    parentSessionId: 'parent-1',
    content: [{ type: 'text', text: '> The office dog\n> is named Max.\n\nWhy Max?' }],
    name: '  The office dog\n  is named Max.  ',
  })).body.value.childId
  const plain = (await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'no quote' }] })).body.value.childId
  expect((await first.call('sidechat.start', { parentSessionId: 'parent-1', content: [{ type: 'text', text: 'x' }], name: 42 })).status).toBe(400)
  expect((await first.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([
    { childId: quoted, name: 'The office dog is named Max.', running: false },
    { childId: plain, running: false },
  ])
  await flush()
  first.unload()

  const second = mount()
  expect((await second.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([
    { childId: quoted, name: 'The office dog is named Max.', running: false },
    { childId: plain, running: false },
  ])
})
