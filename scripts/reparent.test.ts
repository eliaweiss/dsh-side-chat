/**
 * Editing a sent message (dsh-message-rewind) replaces the conversation with a
 * NEW session and deletes the old one. Side chats were keyed to the old id, so
 * after the edit the panel was empty and every side chat looked lost. The
 * rewind plugin now emits `message-rewind/rewound`, and the side chats follow
 * the conversation. "All past side chats" also finds the ones closed from the
 * list, the ones from an earlier version of the conversation, and orphans.
 */
import { mkdir, rm } from 'node:fs/promises'
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
    get: () => undefined,
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
      readSession: async (id: string) => {
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

/** Lay the side-chat sessions out on disk the way DSH stores them (`sessions/<cwd slug>/<id>`). */
async function writeStore(existingParents: string[]): Promise<void> {
  for (const id of [...headers.keys(), ...existingParents]) {
    await mkdir(`${home}/sessions/--work--/${id}`, { recursive: true })
  }
}

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

test('all past side chats: listed, closed, from before an edit, and orphans can be reopened', async () => {
  const m = mount()
  const listed = await start(m, 'parent-1', 'kept')
  const closedEarlier = await start(m, 'parent-1', 'closed before the edit')
  const orphan = await start(m, 'parent-3', 'lost conversation')
  await m.call('sidechat.dispose', { childId: closedEarlier })
  m.emit(REWOUND_EVENT, { sourceSessionId: 'parent-1', sessionId: 'parent-2', action: 'edit' })
  await flush()
  // parent-1 was purged by the rewind; parent-3 was deleted with no successor.
  await writeStore(['session-dummy', 'parent-2'])

  const past = (await m.call('sidechat.past', { parentSessionId: 'parent-2' })).body.value.items
  const byId = new Map(past.map((i: any) => [i.childId, i]))
  expect((byId.get(listed) as any)?.status).toBe('listed')
  expect((byId.get(closedEarlier) as any)?.status).toBe('earlier')
  expect((byId.get(orphan) as any)?.status).toBe('orphan')
  expect((byId.get(closedEarlier) as any)?.preview).toBe(`prompt of ${closedEarlier}`)

  for (const childId of [closedEarlier, orphan]) {
    expect((await m.call('sidechat.reopen', { childId, parentSessionId: 'parent-2' })).status).toBe(200)
  }
  expect(new Set(ids((await m.call('sidechat.list', { parentSessionId: 'parent-2' })).body.value.items)))
    .toEqual(new Set([listed, closedEarlier, orphan]))
  expect((await m.call('sidechat.reopen', { childId: '../etc', parentSessionId: 'parent-2' })).status).toBe(400)
})
