/**
 * dsh-side-chat host half: the /sidechat JSON API. Every side chat is an
 * ORDINARY session (no `origin: 'subagent'`) whose `meta.parentSession` points
 * at the conversation that launched it, kept archived so it appears in neither
 * the main session list nor the subagent catalog, and driven directly through
 * the live agent (followup). Model / reasoning-effort / permission are
 * inherited from the launching conversation at creation and adjustable later.
 *
 * DSH 0.1.7 admits archived sessions to no model step: its archived-session
 * gate answers `{ kind: 'reject' }` on `agent/pre-step` for a session in the
 * registry archive set, so a turn ends `blocked` before the first request. The
 * archive is therefore lifted (unarchived) for exactly as long as a side chat
 * has work queued and restored as soon as its agent settles — see
 * `deliver`/`settleTurn` below.
 *
 * All routes pass the same browser-trust fence as the /api gateway (loopback
 * or trusted authority; cross-site markers refuse).
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as agentApi from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {
  Context,
  SideAgent,
  SideAgentHandle,
  SideImageAttachmentRef,
  SideInstallModelSelection,
  SideInstallModelSwitchNotice,
  SideModelSelection,
  SideModelSelectionRef,
  SidePresetOption,
  SideSession,
  SideSessionEvent,
} from './context-types.ts'
import { SUBCHAT_PREFS_DEFAULTS, type SubchatPrefs } from './settings-shared.ts'
import { DEFAULT_TRUST_PROTOCOL, isTrustedApiRequest, type ApiTrustProtocol } from './trust-fence.ts'
import { optionalBoolean, readJsonBody, requireString, SidechatError, writeError, writeJson, writeOk } from './wire.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-side-chat-plus'

/** Services required before mounting. */
export const inject = [
  'webServer',
  'sessions',
  'agents',
  'workspaceRegistry',
  'sessionQuery',
  'permissionPresets',
  'agentPresets',
  'llm',
  'attachments',
  'commands',
]

/**
 * Read one export of the agent package without tripping the ESM namespace.
 * A missing export is undefined here (older DSH lines), and a test double that
 * models a partial namespace throws on the unknown key instead.
 */
function readAgentExport(name: string): unknown {
  try {
    return (agentApi as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/**
 * Apply a side chat's model / reasoning-effort choice. Two runtime shapes exist:
 *
 * - DSH 0.2.1 and earlier: `installModelSelection(agentCtx, selection)` couples a
 *   MUTABLE ref to `system-prompt/assemble`, `agent/request`, and the model-switch
 *   notice, so a mid-conversation switch lands on a later step.
 * - DSH 0.2.2-alpha.3+: the choice became durable (`agent.model.select()` appends a
 *   `model/selection` event the step preparation fixes before assembly), the same
 *   installer now adds only the notice and takes no selection, and the agent loop
 *   throws when an `agent/request` listener proposes a route different from the
 *   step's fixed selection. `AgentModel` is the new-API marker: the 0.2.1 line
 *   exports no such symbol.
 *
 * Read through the namespace object rather than a named import: a named import
 * fails the ESM link on any build that drops the export, while this degrades to
 * the request-only waterfall in `start`.
 */
const installModelSelection = readAgentExport('installModelSelection') as
  | SideInstallModelSelection
  | SideInstallModelSwitchNotice
  | undefined

/** Whether this runtime records model choices durably on the agent (0.2.2+). */
const durableModelSelection = typeof readAgentExport('AgentModel') === 'function'

/**
 * Record one selection for the agent's NEXT step on a 0.2.2+ runtime. The
 * durable append is what prompt assembly and routing read afterwards, so a
 * switch made between turns (or mid-turn, before the next step prepares)
 * applies without touching request config. A no-op on the coupled 0.2.1 line,
 * which reads the mutable ref instead.
 */
const recordSelection = (agent: SideAgent, selection: SideModelSelection | undefined): void => {
  if (!durableModelSelection || selection === undefined) return
  try {
    agent.model?.select(selection)
  } catch (error) {
    console.warn('[dsh-side-chat] model selection record failed:', error instanceof Error ? error.message : String(error))
  }
}

/** One live side chat the host owns. */
interface SidechatRecord {
  childId: string
  parentSessionId: string
  handle: SideAgentHandle
  /** Live selection coupled to the agent; mutated by `sidechat.selectModel`. */
  selection: SideModelSelectionRef
  createdAt: number
  /** User-given display name (absent = shown by its id). */
  name?: string
  /**
   * Deliveries whose turn has not settled yet. The session stays unarchived
   * while this is non-zero and is archived again when it reaches zero, so a
   * followup sent mid-turn can never be archived out from under itself.
   */
  pendingTurns: number
}

/** Durable record list file (cleanup is a later feature; the list is the record). */
const RECORD_FILE = 'dsh-side-chat-sessions.json'

/** The record-list file path under the harness home. */
function recordFilePath(): string {
  return dshHomePath(RECORD_FILE)
}

/** One durable side-chat record (what survives a restart or plugin reload). */
interface StoredRecord {
  childId: string
  parentSessionId: string
  createdAt: number
  /** User-given display name (absent = shown by its id). */
  name?: string
}

/** Longest side-chat name kept (longer names are cut). */
const MAX_NAME_LENGTH = 200

/** Normalize a user-given side-chat name: one line, trimmed, capped; empty → undefined. */
function normalizeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim()
  return name === '' ? undefined : name
}

/** Read the durable side-chat record list (absent/malformed → empty). */
async function readRecords(): Promise<StoredRecord[]> {
  try {
    const raw = await readFile(recordFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is { childId: string; parentSessionId: string; createdAt: number; name?: unknown } => {
      const record = entry as Record<string, unknown> | null
      return typeof record?.childId === 'string' && typeof record?.parentSessionId === 'string'
    }).map((entry) => {
      const name = normalizeName(entry.name)
      return {
        childId: entry.childId,
        parentSessionId: entry.parentSessionId,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        ...(name === undefined ? {} : { name }),
      }
    })
  } catch {
    return []
  }
}

/** Persist the live side-chat record list (the "record" a future cleanup consumes). */
async function writeRecords(records: StoredRecord[]): Promise<void> {
  const path = recordFilePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(records, null, 2), 'utf8')
}

/**
 * Conversation lineage: when another plugin replaces a conversation with a new
 * session (dsh-message-rewind forks or recreates it on edit/delete and then
 * deletes the source), the side chats move to the successor and the step is
 * remembered here, so "past side chats" can also find side chats that were
 * closed under an earlier version of the same conversation.
 */
const LINEAGE_FILE = 'dsh-side-chat-lineage.json'

/** One replaced → successor step. */
interface LineageStep {
  from: string
  to: string
  at: number
}

/** Event other plugins emit when a conversation is replaced by a new session. */
export const REWOUND_EVENT = 'message-rewind/rewound'

/** Read the lineage steps (absent/malformed → empty). */
async function readLineage(): Promise<LineageStep[]> {
  try {
    const parsed = JSON.parse(await readFile(dshHomePath(LINEAGE_FILE), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is LineageStep => {
      const r = s as Record<string, unknown> | null
      return typeof r?.from === 'string' && typeof r?.to === 'string'
    }).map((s) => ({ from: s.from, to: s.to, at: typeof s.at === 'number' ? s.at : 0 }))
  } catch {
    return []
  }
}

/** Persist the lineage steps. */
async function writeLineage(steps: LineageStep[]): Promise<void> {
  const path = dshHomePath(LINEAGE_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(steps, null, 2), 'utf8')
}

/** Side-chat session ids are minted as `subchat-<uuid>`; refuse anything else. */
const SIDECHAT_ID = /^subchat-[0-9a-zA-Z]+(?:-[0-9a-zA-Z]+)*$/

/**
 * Scan the session store on disk: every side-chat session id and every
 * session id present (a conversation whose directory is gone was deleted).
 */
async function scanSessionStore(): Promise<{ sidechatIds: string[]; existing: Set<string> }> {
  const root = dshHomePath('sessions')
  const sidechatIds: string[] = []
  const existing = new Set<string>()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { sidechatIds, existing }
  }
  const visit = (name: string): void => {
    existing.add(name)
    if (SIDECHAT_ID.test(name)) sidechatIds.push(name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('session-') || entry.name.startsWith('subchat-')) {
      visit(entry.name)
      continue
    }
    let inner
    try {
      inner = await readdir(join(root, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of inner) if (child.isDirectory()) visit(child.name)
  }
  return { sidechatIds, existing }
}

/** One row of the "all past side chats" view. */
interface PastItem {
  childId: string
  name?: string
  createdAt: number
  /** First prompt of the side chat (trimmed), to recognize it. */
  preview: string
  /**
   * `listed`: already in this conversation's list. `closed`: removed from the
   * list earlier (its log is kept). `earlier`: started under an earlier version
   * of this conversation (before an edit/rewind). `orphan`: its conversation
   * was deleted and no successor is known.
   */
  status: 'listed' | 'closed' | 'earlier' | 'orphan'
}

/** Browser-submitted prompt content part (text or base64 image). */
type PromptContentPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string }

/** Model-facing content block (text or durable image reference). */
type ContentBlock = { type: 'text'; text: string } | { type: 'image'; attachment: SideImageAttachmentRef }

/** One transcript block (text or durable image reference). */
type TranscriptBlock = { type: 'text'; text: string } | { type: 'image'; ref: SideImageAttachmentRef } | { type: 'reasoning'; text: string }

/** The lookup guidance appended as an extra text block (hidden from the UI). */
const GUIDANCE_MARKER = '[sidechat-guidance]'
const LOOKUP_GUIDANCE = `${GUIDANCE_MARKER}[需要时，请读取工作区文件或查阅发起此问题的父会话记录来补充信息；若已尽力仍不足，请说明限制。]`
const NO_LOOKUP_GUIDANCE = `${GUIDANCE_MARKER}[请仅基于上述内容直接回答，不要主动查阅工作区文件或父会话记录。]`
/** Legacy (pre-marker) guidance prefixes, filtered so older messages hide too. */
const LEGACY_GUIDANCE_PREFIXES = ['[需要时，请读取工作区文件', '[请仅基于上述内容']

/** Decode one base64 string into bytes (host-side; Node Buffer). */
function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/** A user-role message value `agent.followup` accepts (identity + content + source). */
function userMessage(content: ContentBlock[]): { id: string; role: 'user'; content: ContentBlock[]; source: { kind: 'user' } } {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' },
  }
}

/** Fold a raw session event log into a minimal user/assistant transcript with image refs. */
function foldTranscript(events: readonly { type: string; data: Record<string, unknown> }[]): Array<{ role: 'user' | 'assistant'; blocks: TranscriptBlock[] }> {
  const fold = (content: unknown): TranscriptBlock[] => {
    if (!Array.isArray(content)) return []
    const blocks: TranscriptBlock[] = []
    for (const raw of content) {
      const b = raw as Record<string, unknown> | null
      if (b?.type === 'text' && typeof b.text === 'string') {
        const text = b.text
        const hidden = text.startsWith(GUIDANCE_MARKER) || LEGACY_GUIDANCE_PREFIXES.some((prefix) => text.startsWith(prefix))
        if (!hidden) blocks.push({ type: 'text', text })
      } else if (b?.type === 'image' && b.attachment !== null && typeof b.attachment === 'object') {
        blocks.push({ type: 'image', ref: b.attachment as SideImageAttachmentRef })
      } else if (b?.type === 'reasoning' && typeof b.text === 'string') {
        blocks.push({ type: 'reasoning', text: b.text })
      }
    }
    return blocks
  }
  const messages: Array<{ role: 'user' | 'assistant'; blocks: TranscriptBlock[] }> = []
  for (const event of events) {
    if (event.type === 'user/message') {
      // Skip plugin-injected runtime context (system prompt contexts like the
      // sandbox policy), which the loop projects as user/message events.
      const source = (event.data as { source?: { kind?: string } }).source
      if (source !== undefined && source.kind !== 'user') continue
      const blocks = fold(event.data.content)
      if (blocks.length > 0) messages.push({ role: 'user', blocks })
    } else if (event.type === 'assistant/message') {
      const message = event.data.message as Record<string, unknown> | null
      const blocks = fold(message?.content)
      if (blocks.length > 0) messages.push({ role: 'assistant', blocks })
    }
  }
  return messages
}

/** The start time of the still-open turn, or undefined when no turn is running. */
function openTurnStart(events: readonly SideSessionEvent[]): number | undefined {
  let lastStart: number | undefined
  let lastEnd: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') lastStart = event.time
    else if (event.type === 'turn/end') lastEnd = event.time
  }
  if (lastStart === undefined) return undefined
  if (lastEnd !== undefined && lastEnd >= lastStart) return undefined
  return lastStart
}

/** Schemastery schema for the user-facing preferences (validated by the settings service). */
const PrefsSchema: z<SubchatPrefs> = z.object({
  lookupDefault: z.boolean().default(SUBCHAT_PREFS_DEFAULTS.lookupDefault),
  sendImmediately: z.boolean().default(SUBCHAT_PREFS_DEFAULTS.sendImmediately),
  defaultPrompt: z.string().default(SUBCHAT_PREFS_DEFAULTS.defaultPrompt),
  bringMode: z.union(['draft', 'context']).default(SUBCHAT_PREFS_DEFAULTS.bringMode),
  panelHome: z.union(['floating', 'sidebar-right']).default(SUBCHAT_PREFS_DEFAULTS.panelHome),
})

// DSH 0.1.7 derives settings from the Loader entry's live Config fields.
// Volatile preferences update without disposing the running side chats.
export const Config = PrefsSchema.volatile()

/** Live settings face (bound when the settings service is mounted). */
interface SubchatSettingsFace {
  get(): { value?: unknown; revision?: number }
  update(patch: Record<string, unknown>, expectedRevision?: number): Promise<{ value?: unknown; revision?: number }>
}

/** The API method table bound to the plugin context and the live side-chat map. */
function buildApi(ctx: Context, sideChats: Map<string, SidechatRecord>, getSettings: () => SubchatSettingsFace | undefined) {
  /**
   * Side chats recorded by an earlier run whose agents are not live in this
   * one (the app restarted or the plugin reloaded). They stay listed under
   * their conversation and are resumed on their next message.
   */
  const dormant = new Map<string, StoredRecord>()
  const loaded: Promise<void> = (async () => {
    for (const record of await readRecords()) {
      if (sideChats.has(record.childId) || dormant.has(record.childId)) continue
      // Drop records whose session no longer exists (deleted elsewhere).
      try {
        await ctx.sessionQuery.readSession(record.childId)
      } catch {
        continue
      }
      dormant.set(record.childId, record)
    }
  })().catch((error: unknown) => {
    console.warn('[dsh-side-chat] record restore failed:', error instanceof Error ? error.message : String(error))
  })

  /**
   * Persist live and dormant records (best-effort; never blocks the API).
   * Writes wait for the restore above, so an early write can never drop the
   * records of an earlier run, and run one at a time in call order.
   */
  let writeChain: Promise<void> = loaded
  const persist = (): void => {
    writeChain = writeChain.then(async () => {
      const records: StoredRecord[] = [...sideChats.values()].map((record) => ({
        childId: record.childId,
        parentSessionId: record.parentSessionId,
        createdAt: record.createdAt,
        ...(record.name === undefined ? {} : { name: record.name }),
      }))
      for (const record of dormant.values()) {
        if (!sideChats.has(record.childId)) records.push(record)
      }
      records.sort((a, b) => a.createdAt - b.createdAt)
      await writeRecords(records)
    }).catch((error: unknown) => {
      console.warn('[dsh-side-chat] record write failed:', error instanceof Error ? error.message : String(error))
    })
  }

  /** Narrow a payload value to a non-empty prompt content array. */
  const requireContent = (payload: unknown): PromptContentPart[] => {
    const record = payload as Record<string, unknown> | null
    const content = record?.content
    if (!Array.isArray(content) || content.length === 0) {
      throw new SidechatError('bad-request', 'missing or invalid "content"')
    }
    const parts: PromptContentPart[] = []
    for (const raw of content) {
      const part = raw as Record<string, unknown> | null
      if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') {
        parts.push({ type: 'text', text: part.text })
      } else if (part?.type === 'image' && typeof part.mediaType === 'string' && typeof part.data === 'string' && part.data !== '') {
        parts.push({
          type: 'image',
          mediaType: part.mediaType,
          data: part.data,
          ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
        })
      } else {
        throw new SidechatError('bad-request', 'invalid content block')
      }
    }
    if (parts.every((p) => p.type !== 'text')) {
      // Content must carry at least one text block (image-only prompts unsupported).
      throw new SidechatError('bad-request', 'content must include text')
    }
    return parts
  }

  /** Promote browser base64 images to durable references; append hidden guidance. */
  const durableContent = async (parts: PromptContentPart[], lookupEnabled: boolean): Promise<ContentBlock[]> => {
    const limits = ctx.attachments.imageLimits
    const images = parts.filter((p) => p.type === 'image')
    if (images.length > limits.maxImagesPerMessage) {
      throw new SidechatError('too-many-images', `prompt exceeds the ${limits.maxImagesPerMessage}-image limit`, 400)
    }
    const blocks: ContentBlock[] = []
    for (const part of parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text })
      } else {
        const data = decodeBase64(part.data)
        try {
          await ctx.attachments.validateImage({ data, mediaType: part.mediaType, ...(part.name === undefined ? {} : { name: part.name }) })
          const attachment = await ctx.attachments.saveImage({ data, mediaType: part.mediaType, ...(part.name === undefined ? {} : { name: part.name }) })
          blocks.push({ type: 'image', attachment })
        } catch (error) {
          // The attachment store rejects a malformed/oversized image with its
          // own error type; report it as a client-side bad request (400) rather
          // than an unexplained host fault (500).
          throw new SidechatError('bad-image', error instanceof Error ? error.message : String(error), 400)
        }
      }
    }
    blocks.push({ type: 'text', text: lookupEnabled ? LOOKUP_GUIDANCE : NO_LOOKUP_GUIDANCE })
    return blocks
  }

  /** Resolve the live launching agent (the side chat's durable parent must be live to start/continue). */
  const parentOf = (parentSessionId: string): SideAgent => {
    const parent = ctx.agents.get(parentSessionId)
    if (parent === undefined) {
      throw new SidechatError('parent-unavailable', 'the launching conversation is not live; reopen it to start or continue a side chat', 409)
    }
    return parent
  }

  /**
   * The launching conversation's NEXT-STEP model choice.
   *
   * DSH 0.2.2-alpha.3 keeps a durable selection on the agent (`agent.model`), and a
   * model switch recorded in the main conversation applies from the next step,
   * while `session.requestHeader()` still reports the previous request. Reading
   * the durable choice first is what makes a side chat launched right after a
   * switch inherit the newly selected model; older runtimes expose no `model`
   * and fall back to the request header, then to the agent's own options.
   */
  const parentRoute = (parent: SideAgent): { provider: string; model: string; reasoningEffort?: string } => {
    const selected = parent.model?.current?.()
    const config = parent.session.requestHeader?.()?.config
    const effort = selected?.reasoningEffort ?? config?.reasoningEffort
    return {
      provider: selected?.provider ?? config?.provider ?? parent.options.provider ?? '',
      model: selected?.model ?? config?.model ?? parent.options.model ?? '',
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  }

  /** The parent conversation's current model selection (for staged-mode display). */
  const inherit = (payload: unknown): { provider: string; model: string; reasoningEffort?: string } => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    return parentRoute(parentOf(parentSessionId))
  }

  /** Resolve the live side-chat agent behind a childId. */
  const childOf = (childId: string): SideAgent => {
    const record = sideChats.get(childId)
    if (record !== undefined) return record.handle.agent
    const live = ctx.agents.get(childId)
    if (live !== undefined) return live
    throw new SidechatError('child-unavailable', `side chat "${childId}" is not live`, 409)
  }

  /** Resolve the live side-chat session (for permission writes). */
  const sessionOf = (childId: string): SideSession => {
    const child = childOf(childId)
    const session = ctx.sessions.get(childId) ?? child.session
    if (session === undefined) throw new SidechatError('child-unavailable', `side chat "${childId}" has no session`, 409)
    return session
  }

  /** List the host slash commands available to one side-chat agent. */
  const commands = async (payload: unknown): Promise<{ commands: Array<{ name: string; description: string }> }> => {
    const childId = requireString(payload, 'childId')
    const child = await liveChildOf(childId)
    return { commands: ctx.commands.list(child).map((c) => ({ name: c.name, description: c.description })) }
  }

  /** Execute one host slash command against a side-chat agent. */
  const command = async (payload: unknown): Promise<{ executed: boolean }> => {
    const childId = requireString(payload, 'childId')
    const line = requireString(payload, 'line')
    const child = await liveChildOf(childId)
    const result = await ctx.commands.execute(child, line, [], new AbortController().signal)
    return { executed: result !== undefined }
  }

  /**
   * Read a side chat's event log through the session-query service. DSH 0.1.6
   * deprecated the Session's synchronous event getters (`snapshotEvents`,
   * `eventAt`, `ownEvents`); `readSession` is the live-preferred asynchronous
   * read that supersedes them, and the transcript routes already use it.
   */
  const sessionEvents = async (sessionId: string): Promise<readonly SideSessionEvent[]> =>
    (await ctx.sessionQuery.readSession(sessionId)).events

  /** Fold one side-chat agent's plan/goal state for its composer chrome. */
  const state = async (payload: unknown): Promise<{ plan: { active: boolean; pending: boolean }; goal: { id: string; objective: string } | null }> => {
    const childId = requireString(payload, 'childId')
    // Reading the log needs no live agent: a dormant side chat folds the same way.
    await loaded
    if (!dormant.has(childId)) childOf(childId)
    const events = await sessionEvents(childId)
    // Plan fold mirrors dsh-plan-mode's `plan` projection.
    let planActive = false
    let planWanted: boolean | null = null
    // Goal fold mirrors dsh-goal's last-wins `goal/change` projection.
    let goal: { id: string; objective: string } | null = null
    for (const event of events) {
      const data = event.data as Record<string, unknown>
      if (event.type === 'command/run' && data.name === 'plan') {
        if (data.args === undefined) continue
        const wanted = String(data.args).trim() !== 'off'
        if (wanted !== planWanted) planWanted = wanted
      } else if (event.type === 'plan/mode') {
        planActive = data.active === true
        planWanted = null
      } else if (event.type === 'goal/change') {
        if (data.operation === 'clear') {
          goal = null
        } else if (data.goal !== null && typeof data.goal === 'object') {
          const g = data.goal as Record<string, unknown>
          if (typeof g.id === 'string' && typeof g.objective === 'string') {
            goal = { id: g.id, objective: g.objective }
          }
        }
      }
    }
    return {
      plan: { active: planActive, pending: planWanted !== null && planWanted !== planActive },
      goal,
    }
  }

  /**
   * Serialize one side chat's archive/unarchive writes. Both registry calls go
   * through the host registry's own operation queue, so enqueueing them in call
   * order is what decides the final state; this chain keeps that order stable
   * when a settling turn and a new delivery overlap.
   */
  const visibilityQueue = new Map<string, Promise<void>>()
  const queueVisibility = (childId: string, op: () => Promise<void>): Promise<void> => {
    const previous = visibilityQueue.get(childId) ?? Promise.resolve()
    const next = previous.then(op, op)
    visibilityQueue.set(childId, next.then(() => {}, () => {}))
    return next
  }

  /**
   * Restore one side chat's session before a turn. Registries older than the
   * 0.1.7 gate have no `unarchiveSession` (and need none): there the archive
   * simply stays in place for the whole turn. A failed restore propagates: the
   * caller must not deliver a prompt the gate will answer with `blocked`.
   */
  const unarchiveChild = (childId: string): Promise<void> => {
    const unarchive = ctx.workspaceRegistry.unarchiveSession
    if (unarchive === undefined) return archiveChild(childId)
    return queueVisibility(childId, () => unarchive.call(ctx.workspaceRegistry, childId))
  }

  /**
   * Hide one side chat's session again once its agent has settled. Best-effort:
   * a registry that reports the session active (or refuses the write) only
   * leaves it visible until the next settle, never breaks a turn.
   */
  const archiveChild = (childId: string): Promise<void> => {
    return queueVisibility(childId, () => ctx.workspaceRegistry.archiveSession(childId)).catch(() => {})
  }

  /** Count one settled turn and re-archive the session when the last one ends. */
  const settleTurn = (record: SidechatRecord): void => {
    if (record.pendingTurns > 0) record.pendingTurns -= 1
    if (record.pendingTurns > 0) return
    void archiveChild(record.childId)
  }

  /**
   * Hand one prompt to a side chat: lift the archive, deliver, and let the
   * agent's own idle boundary put the session back out of every list. `followup`
   * opens the driver synchronously (the phase turns `running` before it
   * returns), so observing `whenIdle` right after it can never miss the turn.
   */
  const deliver = async (record: SidechatRecord, message: unknown, mode: 'queue' | 'steer' = 'queue'): Promise<void> => {
    record.pendingTurns += 1
    try {
      await unarchiveChild(record.childId)
      // `steer` lands the message at the running turn's next step (the main
      // chat's "Steer message"); `followup` queues it as the next turn. A host
      // without `steer` falls back to queueing.
      const agent = record.handle.agent
      if (mode === 'steer' && typeof agent.steer === 'function') agent.steer(message)
      else agent.followup(message)
    } catch (error) {
      // Balance the count: the delivery never opened a turn.
      settleTurn(record)
      throw error
    }
    void record.handle.agent.whenIdle().then(() => { settleTurn(record) }, () => { settleTurn(record) })
  }

  /**
   * Compose one side-chat agent's scoped world: the launching conversation's
   * toolset/prompt sections and the runtime-adjustable model selection. Shared
   * by a fresh `start` and by `revive` after a restart or plugin reload.
   */
  const setupChild = (agentCtx: Context, parentCtx: Context | undefined, selection: SideModelSelectionRef): void => {
    // Inherit the launching conversation's toolset/prompt sections.
    if (parentCtx !== undefined) {
      ctx.agentPresets.composeFrom(agentCtx, parentCtx)
    }
    // Model / reasoning-effort are adjustable at runtime.
    //
    // 0.2.2+: the choice is durable on the agent (recorded after creation),
    // and the installer only adds the model-switch notice; a request-config
    // rewrite would now throw against the step's fixed selection.
    if (durableModelSelection) {
      ;(installModelSelection as SideInstallModelSwitchNotice | undefined)?.(agentCtx)
      return
    }
    // 0.2.1: the coupled installer snapshots the selection before prompt
    // assembly delegates and applies the same value to the request config,
    // so a switch made mid-turn lands on a later step instead of assembling
    // the prompt for the inherited model while calling the selected one. An
    // absent effort clears the inherited one, restoring default behavior.
    if (installModelSelection !== undefined) {
      ;(installModelSelection as SideInstallModelSelection)(agentCtx, selection)
      return
    }
    // Fallback for builds without that API: rewrites the request config
    // only, which can split prompt assembly from routing mid-turn.
    agentCtx.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
      const resolved = await next()
      const sel = selection.current
      if (sel === undefined) return resolved
      const { reasoningEffort: _drop, ...rest } = resolved
      return {
        ...rest,
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
      }
    })
  }

  /**
   * Bring a dormant side chat (recorded by an earlier run of this plugin, so
   * its agent died with that run) back to life on its persisted session.
   * Concurrent callers share one resume. Returns undefined for an id that is
   * neither live nor recorded.
   */
  const reviving = new Map<string, Promise<SidechatRecord>>()
  const revive = async (childId: string): Promise<SidechatRecord | undefined> => {
    await loaded
    const live = sideChats.get(childId)
    if (live !== undefined) return live
    const stub = dormant.get(childId)
    if (stub === undefined) return undefined
    // Still live in the registry (an earlier run's agent not torn down yet):
    // callers adopt it through `childOf` instead of resuming a second one.
    if (ctx.agents.get(childId) !== undefined) return undefined
    const pending = reviving.get(childId)
    if (pending !== undefined) return pending
    const resume = ctx.agents.resume
    if (typeof resume !== 'function') {
      throw new SidechatError('child-unavailable', 'this DSH version cannot reopen a side chat from an earlier run', 409)
    }
    const run = (async (): Promise<SidechatRecord> => {
      const parent = ctx.agents.get(stub.parentSessionId)
      const route = parent === undefined ? undefined : parentRoute(parent)
      const selection: SideModelSelectionRef = {
        current: route === undefined || route.provider === '' || route.model === '' ? undefined : route,
        assembled: undefined,
      }
      const handle = await resume.call(ctx.agents, {
        resumeSessionId: childId,
        ...(selection.current === undefined ? {} : { agentOptions: { provider: selection.current.provider, model: selection.current.model } }),
        setup: (agentCtx: Context) => { setupChild(agentCtx, parent?.ctx, selection) },
      })
      // 0.2.2+: the durable choice was replayed from the session log; mirror it
      // so a later `selectModel` starts from what the side chat really runs.
      const durable = handle.agent.model?.current?.()
      if (durable !== undefined) selection.current = durable
      if (parent !== undefined) {
        try {
          const preset = ctx.permissionPresets.current(parent.session)
          if (preset !== 'custom') ctx.permissionPresets.set(handle.agent.session, preset)
        } catch (error) {
          console.warn('[dsh-side-chat] permission inherit failed:', error instanceof Error ? error.message : String(error))
        }
      }
      const record: SidechatRecord = {
        childId,
        parentSessionId: stub.parentSessionId,
        handle,
        selection,
        createdAt: stub.createdAt,
        ...(stub.name === undefined ? {} : { name: stub.name }),
        pendingTurns: 0,
      }
      sideChats.set(childId, record)
      dormant.delete(childId)
      persist()
      // Resuming may register the session as active; keep it hidden while idle.
      void archiveChild(childId)
      return record
    })()
    reviving.set(childId, run)
    try {
      return await run
    } finally {
      reviving.delete(childId)
    }
  }

  /** The live agent behind a childId, reviving a dormant side chat first. */
  const liveChildOf = async (childId: string): Promise<SideAgent> => {
    const record = sideChats.get(childId) ?? await revive(childId)
    return record?.handle.agent ?? childOf(childId)
  }

  /** Create one side chat: inherit, record, deliver the first prompt (hidden while idle). */
  const start = async (payload: unknown): Promise<{ childId: string; provider: string; model: string; reasoningEffort?: string }> => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    const content = requireContent(payload)
    const lookupEnabled = optionalBoolean(payload, 'lookupEnabled')
    const parent = parentOf(parentSessionId)
    // Validate and durably store the prompt's images BEFORE the side chat
    // exists: a rejected image must not leave a live, empty side chat (and a
    // persisted record) behind for a request that never ran.
    const blocks = await durableContent(content, lookupEnabled)

    const record = payload as { provider?: unknown; model?: unknown; reasoningEffort?: unknown; preset?: unknown; name?: unknown }
    // The highlighted text a side chat was started from names it; without one
    // the list shows the side chat by its id.
    if (record.name !== undefined && typeof record.name !== 'string') throw new SidechatError('bad-request', '"name" must be a string')
    const name = normalizeName(record.name)
    const inherited = parentRoute(parent)
    const parentConfig = parent.session.requestHeader?.()?.config
    // A client-supplied selection wins over the inherited one (lets the user
    // pick a provider/model before the first send while "send immediately" is off).
    const provider = typeof record.provider === 'string' && record.provider !== '' ? record.provider : inherited.provider
    const model = typeof record.model === 'string' && record.model !== '' ? record.model : inherited.model
    const maxTokens = parentConfig?.maxTokens ?? parent.options.maxTokens
    const explicitEffort = typeof record.reasoningEffort === 'string' && record.reasoningEffort !== '' ? record.reasoningEffort : undefined
    const reasoningEffort = explicitEffort ?? inherited.reasoningEffort
    const cwd = parent.session.header.cwd

    // The mutable ref the agent reads live, so `sidechat.selectModel` takes
    // effect on a later step instead of only after a restart.
    const selection: SideModelSelectionRef = {
      current: {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      assembled: undefined,
    }
    const parentCtx = parent.ctx

    const childId = `subchat-${randomUUID()}`
    const handle = await ctx.agents.create({
      sessionId: childId,
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
        parentSession: parentSessionId,
      },
      agentOptions: {
        provider,
        model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
      setup: (agentCtx: Context) => { setupChild(agentCtx, parentCtx, selection) },
    })

    // Record the inherited/selected route before the first step prepares, so
    // 0.2.2+ runs the side chat on it instead of the options-only fallback.
    recordSelection(handle.agent, selection.current)

    try {
      // Client-supplied preset wins; otherwise inherit the launching
      // conversation's permission preset (skip custom).
      const explicitPreset = typeof record.preset === 'string' && record.preset !== '' ? record.preset : undefined
      const parentPreset = ctx.permissionPresets.current(parent.session)
      const preset = explicitPreset ?? parentPreset
      if (preset !== 'custom') {
        ctx.permissionPresets.set(handle.agent.session, preset)
      }
    } catch (error) {
      console.warn('[dsh-side-chat] permission inherit failed:', error instanceof Error ? error.message : String(error))
    }

    const child: SidechatRecord = {
      childId,
      parentSessionId,
      handle,
      selection,
      createdAt: Date.now(),
      ...(name === undefined ? {} : { name }),
      pendingTurns: 0,
    }
    sideChats.set(childId, child)
    persist()

    await deliver(child, userMessage(blocks))
    return { childId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  /** Deliver one later message to an existing side chat (queued next turn, or steered into the running one). */
  const deliverLater = async (payload: unknown, mode: 'queue' | 'steer'): Promise<{ accepted: true }> => {
    const childId = requireString(payload, 'childId')
    const content = requireContent(payload)
    const lookupEnabled = optionalBoolean(payload, 'lookupEnabled')
    // A side chat from before a restart/reload is resumed on its next message.
    const record = sideChats.get(childId) ?? await revive(childId)
    const child = record?.handle.agent ?? childOf(childId)
    const message = userMessage(await durableContent(content, lookupEnabled))
    if (record === undefined) {
      // A child adopted from the live agent registry (record lost) still needs
      // its archive lifted before a turn it did not create itself.
      await unarchiveChild(childId)
      if (mode === 'steer' && typeof child.steer === 'function') child.steer(message)
      else child.followup(message)
      void child.whenIdle().then(() => { void archiveChild(childId) }, () => { void archiveChild(childId) })
      return { accepted: true }
    }
    await deliver(record, message, mode)
    return { accepted: true }
  }

  const followup = (payload: unknown): Promise<{ accepted: true }> => deliverLater(payload, 'queue')
  const steer = (payload: unknown): Promise<{ accepted: true }> => deliverLater(payload, 'steer')

  /** List the side chats launched by one parent conversation. */
  const list = async (payload: unknown): Promise<{ items: Array<{ childId: string; name?: string; running: boolean; runningSince?: number }> }> => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    const items: Array<{ childId: string; name?: string; running: boolean; runningSince?: number }> = []
    for (const record of sideChats.values()) {
      if (record.parentSessionId !== parentSessionId) continue
      const agent = record.handle.agent
      // "Running" follows the agent's live lifecycle status — the dominant
      // signal the main conversation uses — so the composer flips to the stop
      // button the moment the driver wakes for thinking/streaming, instead of
      // waiting for a durable turn/start to land in the log. A settled driver
      // is always 'idle' again, so a finished turn can never leave the panel
      // stuck on "thinking". Hosts that do not surface the status getter fall
      // back to the open-turn event scan.
      const status = (agent as { status?: string }).status
      const statusRunning = status === 'running'
      // Only the status-less fallback pays for a log read.
      const eventRunningSince = status === undefined ? openTurnStart(await sessionEvents(record.childId)) : undefined
      const running = statusRunning || (status === undefined && eventRunningSince !== undefined)
      const runningSince = running ? (eventRunningSince ?? Date.now()) : undefined
      items.push({
        childId: record.childId,
        ...(record.name === undefined ? {} : { name: record.name }),
        running,
        ...(runningSince !== undefined ? { runningSince } : {}),
      })
    }
    // Side chats from an earlier run stay listed (idle) until reopened.
    await loaded
    for (const record of dormant.values()) {
      if (record.parentSessionId !== parentSessionId || sideChats.has(record.childId)) continue
      items.push({ childId: record.childId, ...(record.name === undefined ? {} : { name: record.name }), running: false })
    }
    const createdAt = (id: string): number => sideChats.get(id)?.createdAt ?? dormant.get(id)?.createdAt ?? 0
    items.sort((a, b) => createdAt(a.childId) - createdAt(b.childId))
    return { items }
  }

  /** Interrupt the active side chat's current turn (user-initiated stop). */
  const stop = (payload: unknown): { accepted: true } => {
    const childId = requireString(payload, 'childId')
    // A dormant side chat has no turn to stop.
    if (!sideChats.has(childId) && dormant.has(childId) && ctx.agents.get(childId) === undefined) return { accepted: true }
    const child = childOf(childId)
    child.cancel({ kind: 'user' })
    return { accepted: true }
  }

  /** Fold one side chat's transcript. */
  const history = async (payload: unknown): Promise<{ messages: Array<{ role: 'user' | 'assistant'; blocks: TranscriptBlock[] }> }> => {
    const childId = requireString(payload, 'childId')
    let events: readonly SideSessionEvent[]
    try {
      events = (await ctx.sessionQuery.readSession(childId)).events
    } catch (error) {
      // A side chat whose session is gone (deleted, disposed, or an id from a
      // previous run) is a client-side absence, not a host fault.
      throw new SidechatError('not-found', error instanceof Error ? error.message : String(error), 404)
    }
    return { messages: foldTranscript(events) }
  }

  /** The deployment-resolved image policy (for client-side fast-path checks). */
  const limits = (): { mediaTypes: string[]; maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number; maxImagePixels: number; maxImageDimension?: number } => {
    const l = ctx.attachments.imageLimits
    return {
      mediaTypes: [...l.mediaTypes],
      maxImageBytes: l.maxImageBytes,
      maxImagesPerMessage: l.maxImagesPerMessage,
      maxMessageImageBytes: l.maxMessageImageBytes,
      maxImagePixels: l.maxImagePixels,
      // Added in 0.1.6; earlier lines leave it absent so the client skips the check.
      ...(l.maxImageDimension === undefined ? {} : { maxImageDimension: l.maxImageDimension }),
    }
  }

  /** Read one durable image's bytes for transcript rendering. */
  const attachment = async (payload: unknown): Promise<{ mediaType: string; data: string }> => {
    const childId = requireString(payload, 'childId')
    const attachmentId = requireString(payload, 'attachmentId')
    const snapshot = await ctx.sessionQuery.readSession(childId)
    for (const message of foldTranscript(snapshot.events)) {
      for (const block of message.blocks) {
        if (block.type === 'image' && block.ref.attachmentId === attachmentId) {
          const stored = await ctx.attachments.readImage(block.ref)
          return { mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
        }
      }
    }
    throw new SidechatError('not-found', `image "${attachmentId}" not found`, 404)
  }

  /** Adjust one side chat's model / reasoning-effort. */
  const selectModel = async (payload: unknown): Promise<{ accepted: true }> => {
    const childId = requireString(payload, 'childId')
    const provider = requireString(payload, 'provider')
    const model = requireString(payload, 'model')
    const record = sideChats.get(childId) ?? await revive(childId)
    if (record === undefined) throw new SidechatError('child-unavailable', `side chat "${childId}" is not live`, 409)
    const reasoningEffort = (payload as Record<string, unknown> | null)?.reasoningEffort
    // Replace the whole object so the coupled listeners never observe a
    // half-written selection (provider switched, model still inherited).
    record.selection.current = {
      provider,
      model,
      ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
    }
    // 0.2.2+: log the durable choice for the next step. The 0.2.1 line reads
    // the mutable ref through its coupled listeners instead.
    recordSelection(record.handle.agent, record.selection.current)
    return { accepted: true }
  }

  /** Adjust one side chat's permission preset. */
  const selectPermission = async (payload: unknown): Promise<{ accepted: true }> => {
    const childId = requireString(payload, 'childId')
    const presetName = requireString(payload, 'presetName')
    await liveChildOf(childId)
    const session = sessionOf(childId)
    ctx.permissionPresets.set(session, presetName)
    return { accepted: true }
  }

  /**
   * Rename one side chat (live or dormant). An empty name clears it, so the
   * list shows the side chat by its id again. The name lives in the record
   * file only; the hidden session itself is untouched.
   */
  const rename = async (payload: unknown): Promise<{ name?: string }> => {
    const childId = requireString(payload, 'childId')
    const raw = (payload as Record<string, unknown> | null)?.name
    if (raw !== undefined && typeof raw !== 'string') throw new SidechatError('bad-request', '"name" must be a string')
    const name = normalizeName(raw)
    await loaded
    const target: { name?: string } | undefined = sideChats.get(childId) ?? dormant.get(childId)
    if (target === undefined) throw new SidechatError('not-found', `side chat "${childId}" not found`, 404)
    if (name === undefined) delete target.name
    else target.name = name
    persist()
    return name === undefined ? {} : { name }
  }

  /** Close one side chat (tears down its agent and session). */
  const dispose = async (payload: unknown): Promise<{ accepted: true }> => {
    const childId = requireString(payload, 'childId')
    await loaded
    // Ending a dormant side chat only forgets its record (no live agent to stop).
    if (dormant.delete(childId)) persist()
    const record = sideChats.get(childId)
    if (record !== undefined) {
      sideChats.delete(childId)
      try {
        await record.handle.dispose()
      } catch (error) {
        console.warn('[dsh-side-chat] dispose failed:', error instanceof Error ? error.message : String(error))
      }
      persist()
    }
    return { accepted: true }
  }

  /**
   * Conversation lineage (replaced → successor), loaded once and appended to
   * on every reparent. Writes run one at a time in call order.
   */
  let lineage: LineageStep[] = []
  const lineageLoaded: Promise<void> = readLineage().then((steps) => { lineage = steps }, () => {})
  let lineageChain: Promise<void> = lineageLoaded
  const persistLineage = (): void => {
    lineageChain = lineageChain.then(() => writeLineage(lineage)).catch((error: unknown) => {
      console.warn('[dsh-side-chat] lineage write failed:', error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * Move every side chat of one conversation to its successor. A conversation
   * edit/rewind (dsh-message-rewind) replaces the conversation with a NEW
   * session and deletes the old one, so without this the side chats stayed
   * keyed to a deleted id and vanished from the panel.
   *
   * The map updates are synchronous, so a list request that arrives right
   * after the replacement already sees the moved side chats. An idle live side
   * chat is put to sleep (agent disposed, log kept) so its next message
   * resumes it composed from the successor instead of the dying conversation;
   * one with a turn in flight keeps running and simply changes owner.
   */
  const reparent = async (payload: unknown): Promise<{ moved: number }> => {
    const from = requireString(payload, 'fromSessionId')
    const to = requireString(payload, 'toSessionId')
    if (from === to) return { moved: 0 }
    await loaded
    let moved = 0
    const sleeping: SidechatRecord[] = []
    for (const record of sideChats.values()) {
      if (record.parentSessionId !== from) continue
      record.parentSessionId = to
      moved += 1
      const status = (record.handle.agent as { status?: string }).status
      if (record.pendingTurns === 0 && status !== 'running') sleeping.push(record)
    }
    for (const record of dormant.values()) {
      if (record.parentSessionId !== from) continue
      record.parentSessionId = to
      moved += 1
    }
    for (const record of sleeping) {
      sideChats.delete(record.childId)
      dormant.set(record.childId, {
        childId: record.childId,
        parentSessionId: to,
        createdAt: record.createdAt,
        ...(record.name === undefined ? {} : { name: record.name }),
      })
    }
    persist()
    await lineageLoaded
    lineage.push({ from, to, at: Date.now() })
    persistLineage()
    for (const record of sleeping) {
      try {
        await record.handle.dispose()
      } catch (error) {
        console.warn('[dsh-side-chat] dispose on reparent failed:', error instanceof Error ? error.message : String(error))
      }
      void archiveChild(record.childId)
    }
    return { moved }
  }

  /** Header + first prompt of one side-chat session (never changes; cached). */
  const headerCache = new Map<string, { parentSessionId?: string; cwd?: string; createdAt: number; preview: string } | null>()
  const sidechatHeader = async (childId: string): Promise<{ parentSessionId?: string; cwd?: string; createdAt: number; preview: string } | null> => {
    const cached = headerCache.get(childId)
    if (cached !== undefined) return cached
    let value: { parentSessionId?: string; cwd?: string; createdAt: number; preview: string } | null
    try {
      const read = await ctx.sessionQuery.readSession(childId)
      const header = read.session
      const firstUser = foldTranscript(read.events).find((m) => m.role === 'user')
      const text = firstUser?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ') ?? ''
      value = {
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : (read.events[0]?.time ?? 0),
        preview: text.replace(/\s+/g, ' ').trim().slice(0, 160),
      }
    } catch {
      value = null
    }
    // An unreadable session may still be mid-creation: only cache good reads.
    if (value !== null) headerCache.set(childId, value)
    return value
  }

  /**
   * Every side chat ever started for one conversation, including the ones
   * closed from the list, the ones started under earlier versions of it
   * (before an edit/rewind), and orphans whose conversation was deleted with no
   * known successor (from the same folder) so they can be brought back.
   */
  const past = async (payload: unknown): Promise<{ items: PastItem[] }> => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    await loaded
    await lineageLoaded
    // Earlier versions of this conversation: walk the lineage backwards.
    const versions = new Set<string>([parentSessionId])
    for (let grew = true; grew;) {
      grew = false
      for (const step of lineage) {
        if (versions.has(step.to) && !versions.has(step.from)) {
          versions.add(step.from)
          grew = true
        }
      }
    }
    const succeeded = new Set(lineage.map((step) => step.from))
    const parentCwd = ctx.agents.get(parentSessionId)?.session.header.cwd
    const { sidechatIds, existing } = await scanSessionStore()
    const recordOf = (childId: string): { parentSessionId: string; name?: string; createdAt: number } | undefined =>
      sideChats.get(childId) ?? dormant.get(childId)
    const items: PastItem[] = []
    for (const childId of sidechatIds) {
      const header = await sidechatHeader(childId)
      if (header === null) continue
      const record = recordOf(childId)
      const name = record?.name
      const base = {
        childId,
        ...(name === undefined ? {} : { name }),
        createdAt: record?.createdAt || header.createdAt,
        preview: header.preview,
      }
      if (record !== undefined) {
        if (record.parentSessionId === parentSessionId) {
          items.push({ ...base, status: 'listed' })
          continue
        }
        // Listed under a deleted conversation that has no known successor.
        const gone = !existing.has(record.parentSessionId) && !succeeded.has(record.parentSessionId)
        if (gone && (parentCwd === undefined || header.cwd === parentCwd)) items.push({ ...base, status: 'orphan' })
        continue
      }
      const owner = header.parentSessionId
      if (owner === undefined) continue
      if (owner === parentSessionId) {
        items.push({ ...base, status: 'closed' })
      } else if (versions.has(owner)) {
        items.push({ ...base, status: 'earlier' })
      } else if (!existing.has(owner) && !succeeded.has(owner) && (parentCwd === undefined || header.cwd === parentCwd)) {
        items.push({ ...base, status: 'orphan' })
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt)
    return { items }
  }

  /** Put one past side chat (closed, earlier, or orphaned) back into a conversation's list. */
  const reopen = async (payload: unknown): Promise<{ accepted: true }> => {
    const childId = requireString(payload, 'childId')
    const parentSessionId = requireString(payload, 'parentSessionId')
    if (!SIDECHAT_ID.test(childId)) throw new SidechatError('bad-request', 'not a side-chat id')
    await loaded
    const live = sideChats.get(childId)
    if (live !== undefined) {
      live.parentSessionId = parentSessionId
    } else {
      const header = await sidechatHeader(childId)
      if (header === null) throw new SidechatError('not-found', `side chat "${childId}" not found`, 404)
      const stub = dormant.get(childId)
      if (stub !== undefined) stub.parentSessionId = parentSessionId
      else dormant.set(childId, { childId, parentSessionId, createdAt: header.createdAt || Date.now() })
    }
    persist()
    void archiveChild(childId)
    return { accepted: true }
  }

  /** Summarize one piece of text with the side chat's (inherited) model. */
  const summarize = async (payload: unknown): Promise<{ summary: string }> => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    const text = requireString(payload, 'text')
    const record = payload as { provider?: unknown; model?: unknown; reasoningEffort?: unknown; locale?: unknown }

    // Inherit the launching conversation's model unless the client supplied one.
    const inherited = parentRoute(parentOf(parentSessionId))
    const provider = typeof record.provider === 'string' && record.provider !== '' ? record.provider : inherited.provider
    const model = typeof record.model === 'string' && record.model !== '' ? record.model : inherited.model
    if (provider === '' || model === '') {
      throw new SidechatError('bad-request', 'no model available for summarization')
    }
    const reasoningEffort = typeof record.reasoningEffort === 'string' && record.reasoningEffort !== '' ? record.reasoningEffort : inherited.reasoningEffort

    const locale = typeof record.locale === 'string' && record.locale === 'en' ? 'en' : 'zh'
    const prompt = locale === 'en'
      ? `Summarize the following content concisely. Keep the key points and output only the summary:\n\n${text}`
      : `请对以下内容做简明扼要的摘要，保留关键信息，只输出摘要本身：\n\n${text}`

    const chunks = ctx.llm.stream({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      maxTokens: 1024,
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }],
    })

    let summary = ''
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        summary += chunk.text
      }
    }
    const trimmed = summary.trim()
    if (trimmed === '') {
      throw new SidechatError('summarize-empty', 'the model returned no summary', 502)
    }
    return { summary: trimmed }
  }

  /** Inject one piece of text into the main conversation as a collapsed context row. */
  const inject = (payload: unknown): { accepted: true } => {
    const parentSessionId = requireString(payload, 'parentSessionId')
    const text = requireString(payload, 'text')
    const record = payload as { summary?: unknown }
    const summary = typeof record.summary === 'string' && record.summary.trim() !== '' ? record.summary.trim() : '从侧边聊天带回'
    const parent = parentOf(parentSessionId)
    parent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // V4 rejects the retired { kind: 'plugin', plugin: ... } wrapper.
      // Match the identity assigned to historical messages by V3→V4 migration.
      source: { kind: 'plugin:dsh-side-chat', form: 'notice', summary },
    })
    return { accepted: true }
  }

  /** Full model directory: provider groups → models → reasoning efforts. */
  const directory = async (): Promise<{
    groups: Array<{
      id: string
      name: string
      models: Array<{
        id: string
        name: string
        description?: string
        reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
      }>
    }>
  }> => {
    const providers = ctx.llm.listProviders()
    const groups: Array<{
      id: string
      name: string
      models: Array<{
        id: string
        name: string
        description?: string
        reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
      }>
    }> = []
    for (const provider of providers) {
      const listed = await ctx.llm.listModels(provider.id)
      const models: Array<{
        id: string
        name: string
        description?: string
        reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
      }> = []
      for (const model of listed) {
        const entry: {
          id: string
          name: string
          description?: string
          reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
        } = {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        }
        try {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
          if (info.reasoning !== undefined) {
            entry.reasoning = {
              efforts: info.reasoning.efforts.map((e) => ({ id: e.id, name: e.name })),
              ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
            }
          }
        } catch {
          // A model whose metadata fails still lists, just without effort levels.
        }
        models.push(entry)
      }
      groups.push({ id: provider.id, name: provider.name, models })
    }
    return { groups }
  }

  /** Permission-preset options for the side-chat selector. */
  const permissions = (): { options: Array<{ value: string; name: string; description?: string }>; current: string } => {
    const presets = ctx.permissionPresets
    const toOption = (o: SidePresetOption): { value: string; name: string; description?: string } => ({
      value: o.value,
      name: o.name,
      ...(o.description === undefined ? {} : { description: o.description }),
    })
    // 0.1.6 split the combined `selectFor(knobState)` into a process-level
    // `catalog()` plus a separate current value. Prefer the new face and fall
    // back to the old one so both release lines serve this route.
    const catalog = presets.catalog
    if (typeof catalog === 'function') {
      return {
        options: catalog.call(presets).options.map(toOption),
        current: presets.defaultPreset ?? 'custom',
      }
    }
    const selectFor = presets.selectFor
    if (typeof selectFor === 'function') {
      const select = selectFor.call(presets, {})
      return {
        options: select.options.map(toOption),
        current: select.currentValue,
      }
    }
    throw new SidechatError('permissions-unavailable', 'the permission-presets service exposes neither catalog() nor selectFor()', 503)
  }

  return {
    'sidechat.start': start,
    'sidechat.followup': followup,
    'sidechat.steer': steer,
    'sidechat.list': list,
    'sidechat.history': history,
    'sidechat.stop': stop,
    'sidechat.selectModel': selectModel,
    'sidechat.selectPermission': selectPermission,
    'sidechat.summarize': summarize,
    'sidechat.inject': inject,
    'sidechat.directory': directory,
    'sidechat.permissions': permissions,
    'sidechat.limits': limits,
    'sidechat.attachment': attachment,
    'sidechat.inherit': inherit,
    'sidechat.commands': commands,
    'sidechat.command': command,
    'sidechat.state': state,
    'sidechat.dispose': dispose,
    'sidechat.rename': rename,
    'sidechat.reparent': reparent,
    'sidechat.past': past,
    'sidechat.reopen': reopen,
    // Side-chat preferences (settings service optional; absent → undefined).
    'settings.get': () => {
      const settings = getSettings()
      return settings?.get() ?? { value: undefined, revision: undefined }
    },
    'settings.update': async (payload: unknown) => {
      const settings = getSettings()
      if (settings === undefined) {
        throw new SidechatError('settings-rejected', 'the settings service is not mounted in this deployment', 503)
      }
      const record = payload as { patch?: unknown; expectedRevision?: unknown } | null
      const patch = record?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SidechatError('bad-request', 'patch must be a plain object')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
      try {
        return await settings.update(patch as Record<string, unknown>, expectedRevision)
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          throw new SidechatError('settings-conflict', error.message, 409)
        }
        throw new SidechatError('settings-rejected', error instanceof Error ? error.message : String(error), 400)
      }
    },
  }
}

/**
 * The Loader entry that owns a fiber, as the Loader records it. The owning
 * entry lives on the FIBER (`fiber.entry = fiber.parent[Entry.key]` in
 * cordis-plugin-loader), never as a plain `ctx.entry`; `Entry.options.id` is
 * the raw configured id and `Entry.id` the nested-qualified one, and the
 * settings service keys namespaces by the raw one
 * (`configEditor.entries().find(row => row.options.id === ns)`).
 */
interface SideEntryOwner {
  entry?: { id?: string; options?: { id?: string } }
}

/** One configured Loader row, as much of it as this plugin reads. */
interface SideLoaderEntry {
  options?: {
    id?: string
    name?: string
    config?: unknown
  }
}

/** The loader face this plugin needs (own-entry lookup + trust authorities). */
interface SideLoaderFace {
  locate?: (fiber?: unknown) => string | undefined
  entries?: () => Iterable<SideLoaderEntry>
}

/** The `webStartup` service face (invocation values DSH resolves from flags). */
interface SideWebStartupFace {
  trustedHosts?: unknown
}

/**
 * Resolve this plugin's settings namespace: the Loader entry id that owns the
 * running fiber. Both reads are defensive because this package builds against
 * its own cordis, so the upstream `Fiber.entry` augmentation is not visible
 * here. `undefined` (no owning entry, e.g. a bare programmatic mount) leaves
 * the settings face unbound: the plugin still runs, only its preferences stay
 * unavailable instead of being written to a namespace nobody owns.
 */
function settingsNamespaceOf(ctx: Context): string | undefined {
  const owner = (ctx.fiber as SideEntryOwner | undefined)?.entry
  const fromFiber = owner?.options?.id ?? owner?.id
  if (typeof fromFiber === 'string' && fromFiber !== '') return fromFiber
  const loader = ctx.get('loader') as SideLoaderFace | undefined
  const located = loader?.locate?.(ctx.fiber)
  return typeof located === 'string' && located !== '' ? located : undefined
}

/** The Loader row id and package specifier of DSH's /api connection plugin. */
const CONNECTION_ENTRY_ID = 'connection'
const CONNECTION_PLUGIN_NAME = '@deepseek-ai/dsh-client-connection'

/**
 * Declared non-loopback authorities this deployment serves.
 *
 * DSH 0.2.1-rc.1 made `webStartup.trustedHosts` — one entry per `--trusted-host`
 * value — the source its /api fence reads. The 0.2.0 line instead resolved
 * `webRuntime.trustedHosts` (the invocation values plus LAN literals derived
 * from the active bind) into the `connection` row's config, so both are read
 * and merged: the service first, the row as the fallback that keeps 0.2.0
 * deployments working.
 *
 * Only a string array is accepted. A Loader row retains `!!js` expressions
 * unevaluated (`Entry.options.config` is the raw node, not the value the fiber
 * receives), so a non-array must never reach the fence — it would make the
 * authority comparison throw instead of refusing the request.
 */
function trustedHostsOf(ctx: Context): string[] {
  const hosts = new Set<string>()
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') hosts.add(entry)
    }
  }
  collect((ctx.get('webStartup') as SideWebStartupFace | undefined)?.trustedHosts)
  const loader = ctx.get('loader') as SideLoaderFace | undefined
  for (const entry of loader?.entries?.() ?? []) {
    const options = entry.options
    if (options?.id !== CONNECTION_ENTRY_ID && options?.name !== CONNECTION_PLUGIN_NAME) continue
    collect((options.config as { trustedHosts?: unknown } | undefined)?.trustedHosts)
  }
  return [...hosts]
}

/**
 * The listener's own bind IP literal (DSH 0.2.1-rc.1 fence input). Read from the
 * webserver service so `--host 10.0.0.7` stays reachable even though the literal
 * is deliberately outside `trustedHosts`.
 */
function bindHostOf(ctx: Context): string | undefined {
  const host = ctx.webServer?.host
  return typeof host === 'string' && host !== '' ? host : undefined
}

/**
 * The listener protocol the fence normalizes default Host ports with. Absent
 * before DSH 0.2.1-rc.1 (HTTP-only listeners), where the HTTP default applies.
 */
function listenerProtocolOf(ctx: Context): ApiTrustProtocol {
  return ctx.webServer?.protocol === 'https:' ? 'https:' : DEFAULT_TRUST_PROTOCOL
}

/** Host plugin body: register the /sidechat JSON API routes. */
export function apply(ctx: Context): void {
  const sideChats = new Map<string, SidechatRecord>()
  let settingsFace: SubchatSettingsFace | undefined

  // Settings namespaces are Loader entry ids, including user-renamed rows: the
  // id is read off the owning fiber (see `settingsNamespaceOf`).
  ctx.inject(['settings'], (sctx: Context) => {
    const ns = settingsNamespaceOf(ctx)
    if (ns === undefined) return
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    const viewOf = (): { value?: unknown; revision?: number } => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find((c) => c.ns === ns)
      return descriptor === undefined
        ? { value: undefined, revision: undefined }
        : { value: descriptor.value, revision: descriptor.revision }
    }
    settingsFace = {
      get: viewOf,
      update: async (patch, expectedRevision) => {
        await sctx.settings.update(ns, patch, expectedRevision)
        return viewOf()
      },
    }
    sctx.effect(() => () => { settingsFace = undefined })
  })

  const api = buildApi(ctx, sideChats, () => settingsFace)

  // dsh-message-rewind replaces a conversation with a new session on edit /
  // delete-message and then deletes the old one: carry its side chats over.
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on(REWOUND_EVENT, (event: unknown) => {
    const data = event as { sourceSessionId?: unknown; sessionId?: unknown } | null
    const from = data?.sourceSessionId
    const to = data?.sessionId
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') return
    void api['sidechat.reparent']({ fromSessionId: from, toSessionId: to }).catch((error: unknown) => {
      console.warn('[dsh-side-chat] reparent failed:', error instanceof Error ? error.message : String(error))
    })
  }), 'dsh-side-chat: follow rewound conversations')

  // Tear every live side chat down with the plugin fiber, and put back the
  // archive of any chat that was mid-turn (a live turn is lifted from the
  // archive for its duration, so an unload would otherwise leave it visible).
  ctx.effect(() => {
    return () => {
      const records = [...sideChats.values()]
      sideChats.clear()
      void (async () => {
        for (const record of records) {
          try {
            await record.handle.dispose()
          } catch {
            // A half-disposed agent must not stop the archive restore below.
          }
          try {
            await ctx.workspaceRegistry.archiveSession(record.childId)
          } catch {
            // Best-effort: a still-active session stays visible until next run.
          }
        }
      })()
    }
  }, 'dsh-side-chat: dispose side chats')

  // DSH 0.1.6 lists archived sessions in Settings and lets the user restore
  // one. A side chat is archived precisely so it stays out of the session
  // list, so at activation re-archive every recorded side chat that a restore,
  // an interrupted run (turn still open when the harness stopped), or an older
  // run left visible again. Best-effort: records whose session no longer
  // exists are simply skipped.
  ctx.effect(() => {
    void (async () => {
      for (const record of await readRecords()) {
        try {
          await ctx.workspaceRegistry.archiveSession(record.childId)
        } catch {
          // Unknown/expired ids are expected as the record list ages out.
        }
      }
    })()
  }, 'dsh-side-chat: re-archive recorded side chats')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidechat/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf(ctx), bindHostOf(ctx), listenerProtocolOf(ctx))) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidechat/api/') ? pathname.slice('/sidechat/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown sidechat API method' } })
        return
      }
      const handler = (api as Record<string, (payload: unknown) => unknown>)[method]
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown sidechat API method "${method}"` } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-side-chat: /sidechat/api routes')
}
