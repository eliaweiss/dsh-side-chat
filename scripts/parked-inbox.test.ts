/**
 * A turn that ends in an error (a request timeout, a provider failure) stops
 * the DSH driver without claiming its inbox: a message queued or steered
 * during that turn stays parked until something wakes the agent again. The
 * side chat shows no parked queue, so the host must hand that input back
 * when the agent goes idle, and must not re-archive the session meanwhile.
 */
import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'

const home = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/dsh-side-chat-parked-inbox-test`)

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: (...parts: string[]) => [home, ...parts].join('/'),
}))
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: undefined }))

const { apply } = await import('../src/index.ts')

interface FakeAgent {
  status: 'idle' | 'running'
  /** When set, a woken driver claims nothing (a blocked pre-step). */
  refuse?: boolean
  inbox: { nextTurn: any[]; nextStep: any[]; splice: (target: string, start: number, count: number, inserted: any[]) => any[] }
  /** End the running turn; with `error`, the driver stops and leaves the inbox parked. */
  endTurn: (options?: { error?: boolean }) => Promise<void>
}

function mount() {
  const log: string[] = []
  const agents = new Map<string, any>()
  let route: any
  let child: FakeAgent | undefined

  agents.set('parent-1', {
    id: 'parent-1',
    status: 'idle',
    options: { provider: 'hyper', model: 'v4' },
    session: { header: { cwd: '/w' }, requestHeader: () => ({ config: { provider: 'hyper', model: 'v4' } }) },
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
      callback()
      return undefined
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (options: any) => {
        const nextTurn: any[] = []
        const nextStep: any[] = []
        let idle = Promise.withResolvers<void>()
        idle.resolve()
        const wake = () => {
          if (agent.status === 'running') return
          agent.status = 'running'
          idle = Promise.withResolvers<void>()
          if (agent.refuse === true) return
          // The driver claims the first queued turn as it opens.
          const claimed = nextStep.splice(0).concat(nextTurn.splice(0, 1))
          for (const m of claimed) log.push(`run:${m.content[0].text}`)
        }
        const agent: any = {
          id: options.sessionId,
          status: 'idle',
          options: options.agentOptions,
          session: { id: options.sessionId },
          ctx: {},
          inbox: {
            get nextTurn() { return nextTurn },
            get nextStep() { return nextStep },
            splice: (target: string, start: number, count: number, inserted: any[]) =>
              (target === 'next-turn' ? nextTurn : nextStep).splice(start, count, ...inserted),
          },
          followup: (m: any) => { log.push(`followup:${m.content[0].text}`); nextTurn.push(m); wake() },
          steer: (m: any) => { log.push(`steer:${m.content[0].text}`); nextStep.push(m); wake() },
          inject: vi.fn(),
          cancel: vi.fn(),
          whenIdle: () => idle.promise,
          endTurn: async ({ error = false }: { error?: boolean } = {}) => {
            // A completed turn drains the queue itself; an errored one parks it.
            const more = !error && (nextStep.length > 0 || nextTurn.length > 0)
            if (more) {
              const claimed = nextStep.splice(0).concat(nextTurn.splice(0, 1))
              for (const m of claimed) log.push(`run:${m.content[0].text}`)
            } else {
              agent.status = 'idle'
              idle.resolve()
            }
            for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
          },
        }
        child = agent
        agents.set(options.sessionId, agent)
        options.setup?.({ on: () => {} })
        return { agent, dispose: async () => {} }
      },
    },
    workspaceRegistry: {
      archiveSession: async (id: string) => { log.push(`archive:${id}`) },
      unarchiveSession: async (id: string) => { log.push(`unarchive:${id}`) },
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

  return { call, log, child: () => child! }
}

const text = (t: string) => [{ type: 'text', text: t }]

test('a message queued during a turn that errors still runs, and the session stays unarchived until it does', async () => {
  const h = mount()
  const started = await h.call('sidechat.start', { parentSessionId: 'parent-1', content: text('first') })
  const childId = started.body.value.childId
  await h.call('sidechat.followup', { childId, content: text('queued') })
  expect(h.child().inbox.nextTurn).toHaveLength(1)

  // The running turn fails (e.g. "Request timed out"): the driver parks the queue.
  await h.child().endTurn({ error: true })
  expect(h.log).toContain('run:queued')
  expect(h.child().inbox.nextTurn).toHaveLength(0)
  expect(h.child().status).toBe('running')
  expect(h.log).not.toContain(`archive:${childId}`)

  await h.child().endTurn()
  expect(h.log.at(-1)).toBe(`archive:${childId}`)
})

test('steering parked by an errored turn is resubmitted as steering, ahead of queued turns', async () => {
  const h = mount()
  const started = await h.call('sidechat.start', { parentSessionId: 'parent-1', content: text('first') })
  const childId = started.body.value.childId
  await h.call('sidechat.followup', { childId, content: text('later') })
  await h.call('sidechat.steer', { childId, content: text('push') })

  await h.child().endTurn({ error: true })
  expect(h.log.slice(-3)).toEqual(['steer:push', 'run:push', 'followup:later'])

  await h.child().endTurn()
  await h.child().endTurn()
  expect(h.log.at(-1)).toBe(`archive:${childId}`)
})

test('a message the driver keeps refusing is not resubmitted in a loop', async () => {
  const h = mount()
  const started = await h.call('sidechat.start', { parentSessionId: 'parent-1', content: text('first') })
  const childId = started.body.value.childId
  const agent = h.child()
  await h.call('sidechat.followup', { childId, content: text('stuck') })

  // From here the driver opens turns without claiming (a blocked pre-step).
  agent.refuse = true
  await agent.endTurn({ error: true })
  expect(h.log.filter((entry) => entry === 'followup:stuck')).toHaveLength(2)
  expect(agent.status).toBe('running')

  // The same message is parked again: leave it, settle, re-archive.
  await agent.endTurn({ error: true })
  expect(h.log.filter((entry) => entry === 'followup:stuck')).toHaveLength(2)
  expect(agent.inbox.nextTurn).toHaveLength(1)
  expect(h.log.at(-1)).toBe(`archive:${childId}`)
})
