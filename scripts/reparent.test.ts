/**
 * Editing a sent message (dsh-message-rewind) replaces the conversation with a
 * NEW session and deletes the old one. Side chats were keyed to the old id, so
 * after the edit the panel was empty and every side chat looked lost. The
 * rewind plugin now emits `message-rewind/rewound`, and the side chats follow
 * the conversation. "All past side chats" also finds the ones closed from the
 * list and the ones from an earlier version of the conversation — and only
 * those: side chats of any other conversation never show up.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { beforeEach, expect, test, vi } from 'vitest'

const home = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/dsh-side-chat-reparent-test`)

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: (...parts: string[]) => [home, ...parts].join('/'),
}))
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: undefined }))

const { apply, REWOUND_EVENT } = await import('../src/index.ts')

/** Side-chat session headers "on disk". */
const headers = new Map<string, { parentSession?: string; cwd?: string; createdAt: number }>()

beforeEach(async () => {
  headers.clear()
  await rm(home, { recursive: true, force: true })
})

function makeAgent(id: string, log: string[], cwd = '/work') {
  return {
    id,
    status: 'idle',
    options: { provider: 'hyper', model: 'v4' },
    session: { id, header: { cwd }, requestHeader: () => ({ config: { provider: 'hyper', model: 'v4' } }) },
    ctx: {},
    followup: () => { log.push(`followup:${id}`) },
    steer: () => { log.push(`steer:${id}`) },
    inject: vi.fn(),
    cancel: () => { log.push(`cancel:${id}`) },
    whenIdle: async () => {},
  }
}

function mount() {
  const log: string[] = []
  const agents = new Map<string, any>()
  const listeners = new Map<string, (event: unknown) => void>()
  let route: any
  for (const id of ['parent-1', 'parent-2', 'parent-3']) agents.set(id, makeAgent(id, log))

  const ctx: any = {
    fiber: { entry: { options: { id: 'side-chat-entry' } } },
    get: (service: string) => service === 'sessionPersistence' ? {
      stat: async (id: string) => { log.push(`stat:${id}`); return headers.get(id) },
    } : undefined,
    inject: () => {},
    on: (name: string, fn: (event: unknown) => void) => { listeners.set(name, fn); return () => { listeners.delete(name) } },
    effect: (callback: () => unknown, label?: string) => {
      if (label?.includes('re-archive')) return undefined
      callback()
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (options: any) => {
        const agent = makeAgent(options.sessionId, log)
        agents.set(options.sessionId, agent)
        headers.set(options.sessionId, { parentSession: options.meta.parentSession, cwd: options.meta.cwd, createdAt: Date.now() })
        options.setup?.({ on: () => {} })
        return { agent, dispose: async () => { log.push(`dispose:${options.sessionId}`); agents.delete(options.sessionId) } }
      },
      resume: async (options: any) => {
        log.push(`resume:${options.resumeSessionId}`)
        const agent = makeAgent(options.resumeSessionId, log)
        agents.set(options.resumeSessionId, agent)
        options.setup?.({ on: () => {} })
        return { agent, dispose: async () => { agents.delete(options.resumeSessionId) } }
      },
    },
    sessionQuery: {
      listSessions: async () => {
        log.push('list-headers')
        return [...headers].map(([id, h]) => ({ header: { id, ...h } }))
      },
      observeSession: async (id: string) => {
        log.push(`observe:${id}`)
        const view = await ctx.sessionQuery.readSession(id)
        return { events: view.events, [Symbol.dispose]: () => log.push(`release:${id}`) }
      },
      readSession: async (id: string) => {
        log.push(`read:${id}`)
        const header = headers.get(id)
        if (header === undefined) throw new Error('not found')
        return { session: header, events: [{ type: 'user/message', seq: 0, time: header.createdAt, data: { content: [{ type: 'text', text: `prompt of ${id}` }] } }] }
      },
    },
    workspaceRegistry: { archiveSession: async () => {}, unarchiveSession: async () => {} },
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
  const emit = (name: string, event: unknown) => { listeners.get(name)?.(event) }
  return { call, emit, log, agents }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 100))
const start = async (m: ReturnType<typeof mount>, parentSessionId: string, text: string): Promise<string> =>
  (await m.call('sidechat.start', { parentSessionId, content: [{ type: 'text', text }] })).body.value.childId
const ids = (items: Array<{ childId: string }>) => items.map((i) => i.childId)

test('a rewound conversation keeps its side chats, and they resume on the successor', async () => {
  const m = mount()
  const a = await start(m, 'parent-1', 'one')
  const b = await start(m, 'parent-1', 'two')
  await flush()

  m.emit(REWOUND_EVENT, { sourceSessionId: 'parent-1', sessionId: 'parent-2', action: 'edit' })
  await flush()

  expect(ids((await m.call('sidechat.list', { parentSessionId: 'parent-2' })).body.value.items)).toEqual([a, b])
  expect((await m.call('sidechat.list', { parentSessionId: 'parent-1' })).body.value.items).toEqual([])
  // Idle side chats were put to sleep so they resume composed from the successor.
  expect(m.log).toContain(`dispose:${a}`)
  const sent = await m.call('sidechat.followup', { childId: a, content: [{ type: 'text', text: 'after edit' }] })
  expect(sent.status).toBe(200)
  expect(m.log).toContain(`resume:${a}`)

  // The move is durable: a restart still lists them under the successor.
  await flush()
  const again = mount()
  expect(ids((await again.call('sidechat.list', { parentSessionId: 'parent-2' })).body.value.items)).toEqual([a, b])
})

test('all past side chats: listed, closed, and from before an edit can be reopened', async () => {
  const m = mount()
  const listed = await start(m, 'parent-1', 'kept')
  const closedEarlier = await start(m, 'parent-1', 'closed before the edit')
  const closedNow = await start(m, 'parent-1', 'closed after the edit')
  await m.call('sidechat.dispose', { childId: closedEarlier })
  m.emit(REWOUND_EVENT, { sourceSessionId: 'parent-1', sessionId: 'parent-2', action: 'edit' })
  await flush()
  await m.call('sidechat.dispose', { childId: closedNow })
  // The catalog has no parent-1 header: a rewind purged it.

  const past = (await m.call('sidechat.past', { parentSessionId: 'parent-2' })).body.value.items
  const byId = new Map(past.map((i: any) => [i.childId, i]))
  expect(byId.size).toBe(3)
  expect((byId.get(listed) as any)?.status).toBe('listed')
  expect((byId.get(closedEarlier) as any)?.status).toBe('earlier')
  // Its header still names the pre-edit session, so it reads as "before an edit".
  expect((byId.get(closedNow) as any)?.status).toBe('earlier')
  expect((byId.get(closedEarlier) as any)?.preview).toBe('closed before the edit')

  for (const childId of [closedEarlier, closedNow]) {
    expect((await m.call('sidechat.reopen', { childId, parentSessionId: 'parent-2' })).status).toBe(200)
  }
  const reopened = (await m.call('sidechat.list', { parentSessionId: 'parent-2' })).body.value.items
  expect(new Set(ids(reopened))).toEqual(new Set([listed, closedEarlier, closedNow]))
  expect(reopened).toContainEqual({ childId: closedEarlier, preview: 'closed before the edit', running: false })
  expect((await m.call('sidechat.reopen', { childId: '../etc', parentSessionId: 'parent-2' })).status).toBe(400)
  await flush() // let the background saves finish before the next test wipes the folder
})

test('all past side chats never lists side chats of another conversation', async () => {
  const m = mount()
  const mine = await start(m, 'parent-1', 'mine')
  const otherOpen = await start(m, 'parent-2', 'other, still listed')
  const otherClosed = await start(m, 'parent-2', 'other, closed')
  const fromDeleted = await start(m, 'parent-3', 'its conversation was deleted')
  const fromDeletedClosed = await start(m, 'parent-3', 'closed, conversation deleted')
  await m.call('sidechat.dispose', { childId: otherClosed })
  await m.call('sidechat.dispose', { childId: fromDeletedClosed })
  await flush()
  // No parent-3 header or successor exists: its side chats used to be offered everywhere.

  expect(ids((await m.call('sidechat.past', { parentSessionId: 'parent-1' })).body.value.items)).toEqual([mine])
  expect(new Set(ids((await m.call('sidechat.past', { parentSessionId: 'parent-2' })).body.value.items)))
    .toEqual(new Set([otherOpen, otherClosed]))
  expect(ids((await m.call('sidechat.past', { parentSessionId: 'session-unknown' })).body.value.items)).toEqual([])
  // They still belong to their own conversation.
  expect(new Set(ids((await m.call('sidechat.past', { parentSessionId: 'parent-3' })).body.value.items)))
    .toEqual(new Set([fromDeleted, fromDeletedClosed]))
})

test('legacy discovery imports headers once, reads only matching previews, and survives restart', async () => {
  // A real pre-index installation: its active list has one recorded chat, but
  // only the session store knows about the closed chats and their owners.
  await mkdir(home, { recursive: true })
  const mine = 'subchat-mine'
  const closed = 'subchat-closed'
  const records = Array.from({ length: 150 }, (_, i) => ({ childId: `subchat-other-${i}`, parentSessionId: 'parent-2', createdAt: i }))
  records.push({ childId: mine, parentSessionId: 'parent-1', createdAt: 2 })
  await writeFile(`${home}/dsh-side-chat-sessions.json`, JSON.stringify(records))
  for (const r of records) headers.set(r.childId, { parentSession: r.parentSessionId, createdAt: r.createdAt })
  headers.set(closed, { parentSession: 'parent-1', createdAt: 1 })
  const m = mount()
  const call = (method: string) => m.call(method, { parentSessionId: 'parent-1' }).then(r => r.body.value.items)
  expect(ids(await call('sidechat.list'))).toEqual([mine])
  expect(m.log).toEqual([`stat:${mine}`]) // No full logs, no discovery, no unrelated ID checks.
  const [past, duplicate] = await Promise.all([call('sidechat.past'), call('sidechat.past')])
  expect(duplicate).toEqual(past)
  expect(past.map((r: any) => [r.childId, r.preview, r.status])).toEqual([
    [mine, `prompt of ${mine}`, 'listed'], [closed, `prompt of ${closed}`, 'closed'],
  ])
  expect(m.log.filter(s => s === 'list-headers')).toHaveLength(1)
  expect(m.log.filter(s => s.startsWith('read:'))).toEqual([`read:${mine}`, `read:${closed}`])
  expect(m.log.filter(s => s.startsWith('release:'))).toEqual([`release:${mine}`, `release:${closed}`])
  m.log.length = 0
  await call('sidechat.past')
  expect(m.log).toEqual([])

  const restarted = mount()
  headers.delete(closed)
  const after = await restarted.call('sidechat.past', { parentSessionId: 'parent-1' })
  expect(after.body.value.items).toEqual([past[0]])
  expect(restarted.log).toEqual([`stat:${mine}`, `stat:${closed}`]) // No corpus scan or replay on restart.
})

test('an invalid index is rebuilt; a listed row missing from a valid index is repaired locally', async () => {
  const childId = 'subchat-legacy'
  headers.set(childId, { parentSession: 'parent-1', createdAt: 12 })
  await mkdir(home, { recursive: true })
  const path = `${home}/dsh-side-chat-past-v1.json`
  await writeFile(path, JSON.stringify({ version: 1, imported: true, rows: [null] }))
  await writeFile(`${home}/dsh-side-chat-sessions.json`, JSON.stringify([{ childId, parentSessionId: 'parent-2', createdAt: 12 }]))
  for (const expectScan of [true, false]) {
    if (!expectScan) await writeFile(path, JSON.stringify({ version: 1, imported: true, rows: [] }))
    const m = mount()
    const past = await m.call('sidechat.past', { parentSessionId: 'parent-2' })
    expect(past.body.value.items).toEqual([{ childId, createdAt: 12, status: 'listed', preview: `prompt of ${childId}` }])
    expect(m.log.includes('list-headers')).toBe(expectScan)
    expect((await m.call('sidechat.past', { parentSessionId: 'parent-1' })).body.value.items).toEqual([])
  }
})
