/**
 * Client half of dsh-side-chat: a text-selection floating menu, a right-side
 * side-chat panel (drag-resizable + collapsible), the main-conversation-style
 * model/permission selectors and send/stop buttons, and a "Side chat" settings
 * section. The panel is isolated per current conversation and talks to the
 * host /sidechat API.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  DisclosureRow,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconSendOutlineRegular,
  IconStopFillRegular,
  IconThinkOutlineRegular,
  MarkdownText,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  AttachmentRail,
  DropOverlay,
  ImageGallery,
  ImageLightbox,
  type ImageLoader,
} from './attachments/index.ts'
import { SidechatErrorBoundary } from './ErrorBoundary.tsx'
import { escapeCurrency } from './currency.ts'
import { useCopyText } from './clipboard.ts'
import { FOLLOW_THRESHOLD_PX, STALE_ECHO_MS, unresolvedEchoes, userMessageCount, type PendingEcho } from './pending.ts'
import type { Context, SidePendingInteraction, SideQuestionItem, SideQuestionOption, SideSidebarRight, SideSidebarRightTabs } from '../context-types.ts'
import {
  api,
  type PromptContentPart,
  type SidechatDirectory,
  type SidechatImageRef,
  type SidechatTurnNotice,
  type SidechatListItem,
  type SidechatMessage,
  type SidechatPastItem,
  type SidechatPermissions,
} from './api.ts'
import { en, LOCALE_NS, zh, type SidechatLocaleKey } from './locales.ts'
import { SUBCHAT_PREFS_DEFAULTS, type SubchatPrefs } from '../settings-shared.ts'
import css from './client.module.css'
import './layout.css'

/** Services required before mounting. */
export const inject = ['sessions', 'locale', 'slots', 'conversation', 'uiSession']

/** A text selection the floating menu anchors to. */
interface SelectionAnchor {
  text: string
  x: number
  y: number
}

/** The panel UI state, per current parent conversation. */
interface PanelState {
  open: boolean
  parentSessionId: string
  activeChildId: string | null
  items: SidechatListItem[]
  messages: SidechatMessage[]
  draft: string
  /** Staged selection shown as an attachment while "send immediately" is off. */
  attachment: string | null
  /** Browser-owned draft images (object URLs); serialized on send. */
  attachments: ComposerAttachment[]
  lookup: boolean
  directory: SidechatDirectory | null
  permissions: SidechatPermissions | null
  provider: string
  model: string
  effort: string
  preset: string
  /** Which selector the command menu asked to open (consumed once). */
  commandOpen: 'model' | 'permission' | null
  planActive: boolean
  planPending: boolean
  goalObjective: string | null
  error: string | null
  /** The list area shows every past side chat of this conversation instead of the live list. */
  pastOpen: boolean
}

/**
 * The pending `ask_user_question` of the ACTIVE side chat, with the carrier
 * that answers it. The side panel owns its own composer, so the host's
 * `conversation.composer` question card (which only renders for the main
 * conversation) never reaches it: without this the side agent's question
 * blocked its turn until the user aborted it. Null = no pending question.
 */
interface SideQuestionRequest {
  /** The child session the question belongs to. */
  childId: string
  /** Render identity of the pending request (carrier key). */
  key: string
  /** The question batch to answer. */
  questions: SideQuestionItem[]
  /** Submit the whole batch through the carrier's live channel. */
  answer(batch: { answers: Array<{ id: string; selected: string[]; custom?: string }> }): Promise<void>
}

/** The whole browser-side snapshot. */
interface SidechatSnapshot {
  current: string | undefined
  panel: PanelState
  anchor: SelectionAnchor | null
  prefs: SubchatPrefs
  /** The current main conversation's pending user-question dialog (null = none). */
  mainQuestion: SideQuestionItem[] | null
  /** The active side chat's own pending question (null = none). */
  sideQuestion: SideQuestionRequest | null
  /** Question ids the user deleted from the panel list. */
  dismissedQuestionIds: string[]
  /**
   * Whether this deployment offers the built-in right sidebar. False means
   * `panelHome: 'sidebar-right'` cannot be honoured and the panel falls back to
   * the classic floating container instead of becoming unreachable.
   */
  dockAvailable: boolean
}

/** The whole browser-side store (one per activation). */
interface SidechatStore {
  getSnapshot(): SidechatSnapshot
  subscribe(fn: () => void): () => void
  setCurrent(current: string | undefined): void
  setAnchor(anchor: SelectionAnchor | null): void
  setPrefs(prefs: SubchatPrefs): void
  setMainQuestion(questions: SideQuestionItem[] | null): void
  /** Publish (or clear) the active side chat's own pending question. */
  setSideQuestion(request: SideQuestionRequest | null): void
  /**
   * Retire one answered question key: clears the card and refuses to show that
   * same request again. The host keeps the call listed until its tool result
   * lands, so without this the tracking effect re-published the question the
   * instant it was answered.
   */
  settleSideQuestion(key: string): void
  dismissQuestion(id: string): void
  dismissAllQuestions(ids: string[]): void
  openPanel(parentSessionId: string): void
  closePanel(): void
  /** Install (or clear) the dock-mode launcher; openPanel() fires it after opening. */
  setDockLaunch(fn: (() => void) | null): void
  /** Record whether the built-in right sidebar exists in this deployment. */
  setDockAvailable(available: boolean): void
  setActive(childId: string): void
  patch(partial: Partial<PanelState>): void
}

function emptyPanel(): PanelState {
  return {
    open: false,
    parentSessionId: '',
    activeChildId: null,
    items: [],
    messages: [],
    draft: '',
    attachment: null,
    attachments: [],
    lookup: false,
    directory: null,
    permissions: null,
    provider: '',
    model: '',
    effort: '',
    preset: '',
    commandOpen: null,
    planActive: false,
    planPending: false,
    goalObjective: null,
    error: null,
    pastOpen: false,
  }
}

/** Create the browser store (one instance per activation, per the factory rule). */
function createStore(): SidechatStore {
  let current: string | undefined
  let panel: PanelState = emptyPanel()
  let anchor: SelectionAnchor | null = null
  let prefs: SubchatPrefs = { ...SUBCHAT_PREFS_DEFAULTS }
  let mainQuestion: SideQuestionItem[] | null = null
  let sideQuestion: SideQuestionRequest | null = null
  /** Request keys already answered from this panel; they never come back. */
  const answeredQuestionKeys = new Set<string>()
  let dismissedQuestionIds: string[] = []
  // Optimistic until the dock effect has inspected the services: a deployment
  // whose sidebar services are missing flips this to false and the panel
  // renders floating instead of nowhere.
  let dockAvailable = true
  // Per-conversation panel state so switching away and back restores the side
  // chats instead of resetting them. The side chats stay live on the host, so
  // the client must remember each conversation's open panel + active child.
  const bySession = new Map<string, PanelState>()
  const listeners = new Set<() => void>()
  // Dock mode: while the panel lives in the built-in right sidebar, opening the
  // panel also reveals the tab (registered by the dock effect; null otherwise).
  let dockLaunch: (() => void) | null = null
  // Cached snapshot: useSyncExternalStore compares identity, so the object is
  // only rebuilt on a mutation — never inside getSnapshot itself.
  let snapshot: SidechatSnapshot = { current, panel, anchor, prefs, mainQuestion, sideQuestion, dismissedQuestionIds, dockAvailable }

  const notify = (): void => {
    snapshot = { current, panel, anchor, prefs, mainQuestion, sideQuestion, dismissedQuestionIds, dockAvailable }
    for (const fn of [...listeners]) fn()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    setCurrent(next) {
      if (next === current) return
      if (current !== undefined) bySession.set(current, panel)
      current = next
      panel = next === undefined
        ? emptyPanel()
        : (bySession.get(next) ?? { ...emptyPanel(), parentSessionId: next, lookup: prefs.lookupDefault })
      anchor = null
      mainQuestion = null
      sideQuestion = null
      dismissedQuestionIds = []
      notify()
    },
    setAnchor(next) {
      anchor = next
      notify()
    },
    setPrefs(next) {
      prefs = next
      notify()
    },
    setMainQuestion(questions) {
      mainQuestion = questions
      // Keep dismissal state: a dismissed question must not reappear just
      // because the pending snapshot re-publishes while the dialog is still open.
      notify()
    },
    setSideQuestion(request) {
      // An already-answered request never returns to the card.
      if (request !== null && answeredQuestionKeys.has(request.key)) return
      // Identity-compared by key: the carrier re-publishes on every countdown
      // tick, and rebuilding the snapshot each second would re-render the
      // whole transcript.
      if (request?.key === sideQuestion?.key && request?.childId === sideQuestion?.childId) return
      sideQuestion = request
      notify()
    },
    settleSideQuestion(key) {
      answeredQuestionKeys.add(key)
      if (sideQuestion?.key !== key) return
      sideQuestion = null
      notify()
    },
    dismissQuestion(id) {
      if (!dismissedQuestionIds.includes(id)) {
        dismissedQuestionIds = [...dismissedQuestionIds, id]
        notify()
      }
    },
    dismissAllQuestions(ids) {
      dismissedQuestionIds = [...new Set([...dismissedQuestionIds, ...ids])]
      notify()
    },
    openPanel(parentSessionId) {
      panel = { ...panel, open: true, parentSessionId }
      dockLaunch?.()
      notify()
    },
    closePanel() {
      panel = { ...panel, open: false }
      notify()
    },
    setDockLaunch(fn) {
      dockLaunch = fn
    },
    setDockAvailable(available) {
      if (available === dockAvailable) return
      dockAvailable = available
      notify()
    },
    setActive(childId) {
      panel = { ...panel, activeChildId: childId, messages: [], error: null }
      notify()
    },
    patch(partial) {
      panel = { ...panel, ...partial }
      notify()
    },
  }
}

/** Resolve the localized label for one locale key (module-level active locale). */
function translate(activeLocale: string, key: SidechatLocaleKey): string {
  const dict = activeLocale === 'en' ? en : zh
  return dict[key] ?? key
}

/** Format a run duration like the main conversation: "Xs" / "Xm SSs" (or Chinese). */
function formatRunDuration(ms: number, activeLocale: string): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes > 0) {
    return activeLocale === 'en'
      ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
      : `${minutes}分${String(seconds).padStart(2, '0')}秒`
  }
  return activeLocale === 'en' ? `${seconds}s` : `${seconds}秒`
}

/** Browser-owned draft image (object URL preview). */
interface ComposerAttachment {
  id: string
  file: File
  previewUrl: string
}

/** Accepted image media types (mirror of dsh-attachment's ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Create runtime draft images with object URLs (validates media type). */
function createDraftImages(files: readonly File[]): ComposerAttachment[] {
  return files.map((file) => {
    if (!IMAGE_MEDIA_TYPES.includes(file.type)) {
      throw new Error(`unsupported image type: ${file.type || 'unknown'}`)
    }
    return { id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }
  })
}

/**
 * Read one image file's intrinsic pixel size, releasing the decoded bitmap.
 * Returns null when the browser cannot decode it: the host's `validateImage`
 * stays the authority either way.
 */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

/** Revoke one draft image's preview URL. */
function releaseDraftImage(attachment: ComposerAttachment): void {
  URL.revokeObjectURL(attachment.previewUrl)
}

/** Serialize draft images to base64 prompt parts (mirror of main sendSession). */
async function serializeImages(attachments: readonly ComposerAttachment[]): Promise<PromptContentPart[]> {
  return Promise.all(attachments.map(async (a) => {
    const bytes = new Uint8Array(await a.file.arrayBuffer())
    let binary = ''
    const chunk = 32768
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
    }
    return {
      type: 'image',
      mediaType: a.file.type,
      data: btoa(binary),
      ...(a.file.name === '' ? {} : { name: a.file.name }),
    }
  }))
}

/** Convert a base64 string to an object URL for transcript image rendering. */
function base64ObjectUrl(mediaType: string, data: string): string {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
}

/** Pull the side-chat list for one parent conversation. */
async function refreshList(store: SidechatStore, parentSessionId: string): Promise<void> {
  const result = await api.list({ parentSessionId })
  if (result.ok) store.patch({ items: result.value.items })
}

/** Optimistically flip one side-chat's running flag before the list round-trip. */
function setItemRunning(store: SidechatStore, childId: string, running: boolean): void {
  const items = store.getSnapshot().panel.items
  store.patch({ items: items.map((i) => (i.childId === childId ? { ...i, running } : i)) })
}

/** Pull the active side chat's transcript. */
async function refreshHistory(store: SidechatStore, childId: string): Promise<void> {
  const result = await api.history({ childId })
  if (result.ok) store.patch({ messages: result.value.messages })
}

/** Pull the model directory + permission catalog once. */
async function refreshDirectory(store: SidechatStore): Promise<void> {
  const [directoryResult, permissionsResult] = await Promise.all([
    api.directory(),
    api.permissions(),
  ])
  const patch: Partial<PanelState> = {}
  if (directoryResult.ok) patch.directory = directoryResult.value
  if (permissionsResult.ok) {
    patch.permissions = permissionsResult.value
    // Only seed the preset on first load; never clobber an explicit user pick.
    if (store.getSnapshot().panel.preset === '') {
      patch.preset = permissionsResult.value.current
    }
  }
  store.patch(patch)
}

/** The side-chat's current model selection (provider + model + effort). */
interface ModelSelection {
  provider: string
  model: string
  effort: string
}

/** One directory model's reasoning slice. */
type DirectoryReasoning = SidechatDirectory['groups'][number]['models'][number]['reasoning']

/** The first non-empty line of a reasoning block (collapsed summary). */
function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return end === -1 ? text : text.slice(0, end)
}

/** Main-conversation-style Copy button for one assistant reply (copies its Markdown). */
function CopyReplyButton(props: { text: string; t: (key: SidechatLocaleKey) => string }) {
  const { copied, onCopy } = useCopyText(props.text)
  const label = copied ? props.t('panel.copied') : props.t('panel.copy')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.messageCopyButton}
        aria-label={label}
        data-testid="sidechat-copy-reply"
        data-copied={copied || undefined}
        onClick={onCopy}
      >
        {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
      </button>
    </Tooltip>
  )
}

/** The name a side chat is shown by: its user-given name, else its id. */
function itemName(item: SidechatListItem): string {
  return item.name ?? item.childId
}

/**
 * One row of the side-chat list: select, copy its name, rename it in place
 * (pencil or double-click; Enter/blur saves, Escape cancels, empty clears),
 * and delete.
 */
function SidechatListRow(props: {
  item: SidechatListItem
  active: boolean
  t: (key: SidechatLocaleKey) => string
  onSelect: () => void
  onRename: (name: string) => void
  onDispose: () => void
}) {
  const { item, t } = props
  const name = itemName(item)
  const { copied, onCopy } = useCopyText(name)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** Set once Enter/Escape settled the edit, so the blur that follows is a no-op. */
  const settled = useRef(false)

  const beginEdit = (): void => {
    settled.current = false
    setDraft(item.name ?? '')
    setEditing(true)
  }
  const finish = (save: boolean): void => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    if (save && draft.trim() !== (item.name ?? '')) props.onRename(draft)
  }

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const copyLabel = copied ? t('panel.nameCopied') : t('panel.copyName')
  return (
    <div className={css.panelListItemRow} data-testid="sidechat-list-row">
      {editing
        ? (
            <input
              ref={inputRef}
              className={css.panelListItemRename}
              data-testid="sidechat-rename-input"
              value={draft}
              maxLength={200}
              placeholder={t('panel.renamePlaceholder')}
              aria-label={t('panel.rename')}
              onChange={(e) => { setDraft(e.target.value) }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') { e.preventDefault(); finish(true) }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
              }}
              onBlur={() => { finish(true) }}
            />
          )
        : (
            <button
              type="button"
              className={`${css.panelListItem} ${props.active ? css.panelListItemActive : ''}`}
              title={item.name === undefined ? name : `${name}\n${item.childId}`}
              onClick={props.onSelect}
              onDoubleClick={beginEdit}
            >
              <span className={css.panelListItemDot} data-running={item.running ? '1' : undefined} />
              <span className={css.panelListItemLabel} data-named={item.name === undefined ? undefined : '1'}>{name}</span>
            </button>
          )}
      {!editing && (
        <>
          <Tooltip label={copyLabel} side="bottom">
            <button
              type="button"
              className={css.panelListItemAction}
              aria-label={copyLabel}
              data-testid="sidechat-copy-name"
              data-copied={copied ? '1' : undefined}
              onClick={onCopy}
            >
              {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
            </button>
          </Tooltip>
          <Tooltip label={t('panel.rename')} side="bottom">
            <button
              type="button"
              className={css.panelListItemAction}
              aria-label={t('panel.rename')}
              data-testid="sidechat-rename"
              onClick={beginEdit}
            >
              <IconEditOutlineRegular />
            </button>
          </Tooltip>
        </>
      )}
      <button
        type="button"
        className={css.panelListItemRemove}
        aria-label={t('panel.delete')}
        title={t('panel.delete')}
        data-testid="sidechat-delete"
        onClick={props.onDispose}
      >
        ×
      </button>
    </div>
  )
}

/**
 * Every side chat ever started for this conversation: the listed ones, the
 * ones closed from the list (their log is kept), and the ones started under
 * an earlier version of the conversation (before a message edit/rewind).
 * Side chats of other conversations are never shown. Picking one brings it
 * back into the list and opens it.
 */
function PastSideChats(props: {
  parentSessionId: string
  t: (key: SidechatLocaleKey) => string
  onOpen: (item: SidechatPastItem) => void
}) {
  const { t } = props
  const [items, setItems] = useState<SidechatPastItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    void api.past({ parentSessionId: props.parentSessionId }).then((result) => {
      if (cancelled) return
      if (result.ok) setItems(result.value.items)
      else setError(result.error.message)
    })
    return () => { cancelled = true }
  }, [props.parentSessionId])

  if (error !== null) return <div className={css.panelEmpty} data-testid="sidechat-past-error">{error}</div>
  if (items === null) return <div className={css.panelEmpty} data-testid="sidechat-past-loading">{t('past.loading')}</div>
  if (items.length === 0) return <div className={css.panelEmpty} data-testid="sidechat-past-empty">{t('past.empty')}</div>
  return (
    <div className={css.pastList} data-testid="sidechat-past-list">
      <div className={css.pastTitle}>{t('past.title')}</div>
      {items.map((item) => {
        const label = item.name ?? (item.preview !== '' ? item.preview : item.childId)
        const when = item.createdAt > 0 ? new Date(item.createdAt).toLocaleString() : ''
        return (
          <div key={item.childId} className={css.pastRow} data-testid="sidechat-past-row" data-status={item.status}>
            <div className={css.pastText} title={`${label}\n${item.childId}`}>
              <span className={css.pastLabel}>{label}</span>
              <span className={css.pastMeta}>
                <span className={css.pastStatus} data-status={item.status}>{t(`past.status.${item.status}` as SidechatLocaleKey)}</span>
                {when !== '' && <span>{when}</span>}
              </span>
            </div>
            <button
              type="button"
              className={css.pastOpen}
              disabled={busy !== null}
              data-testid="sidechat-past-open"
              onClick={() => {
                setBusy(item.childId)
                props.onOpen(item)
              }}
            >
              {item.status === 'listed' ? t('past.open') : t('past.restore')}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** The client command surface (`ctx.commandUi`, dsh-client-ui-commands), as much as this plugin uses. */
interface SideCommandUi {
  register(contribution: {
    name: string
    label?(): string
    description?(): string
    icon?: (props: { size?: number | undefined; className?: string | undefined }) => ReactElement
    available(session: { sessionId: string }): boolean
    ui: { kind: 'action'; run(session: { sessionId: string }): void }
  }): () => void
}

/** + menu glyph: a chat bubble beside a side panel. */
function SidechatMenuIcon(props: { size?: number | undefined; className?: string | undefined }) {
  const size = props.size ?? 20
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={props.className} aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12.5 3.5v13" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 8h4M5.5 11h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Main-conversation-style reasoning disclosure row (Think). */
function ReasoningRow(props: { text: string; t: (key: SidechatLocaleKey) => string }) {
  const [expanded, setExpanded] = useState(false)
  const summary = firstLine(props.text)
  return (
    <DisclosureRow
      icon={<IconThinkOutlineRegular size={14} />}
      title={props.t('panel.think')}
      open={expanded}
      expandable={true}
      expandOnRowClick={true}
      onToggle={() => { setExpanded((value) => !value) }}
      collapsedContent={<span className={css.reasoningSummary}>{summary}</span>}
    >
      <div className={css.reasoningBody}>{props.text}</div>
    </DisclosureRow>
  )
}

/**
 * Main-conversation-style row for how a turn ended (failed, stopped, or cut at
 * the output cap). Copy mirrors the main chat's turn-error row.
 */
function TurnNoticeRow(props: { notice: SidechatTurnNotice; t: (key: SidechatLocaleKey) => string }) {
  const { notice, code } = props.notice
  const title = notice === 'max-tokens' ? props.t('turn.maxTokens') : notice === 'stopped' ? props.t('turn.stopped') : props.t('turn.failed')
  const message = code === 'ACCOUNT_SIGNED_OUT' ? props.t('turn.failure.signedOut')
    : code === 'INTERRUPTED' ? props.t('turn.failure.interrupted')
      : code === 'ACCOUNT_SIGN_IN_REQUIRED' ? props.t('turn.failure.signInRequired')
        : code === 'QUOTA' || code === 'ACCOUNT_QUOTA' ? props.t('turn.failure.quota')
          : code === 'AUTH' ? props.t('turn.failure.auth')
            : props.notice.message
  return (
    <div className={css.turnNotice} data-sidechat-turn-notice={notice} data-testid="sidechat-turn-notice" role="status">
      <span className={notice === 'max-tokens' ? css.turnNoticeDotWarn : css.turnNoticeDot} />
      <div className={css.turnNoticeCopy}>
        <span className={notice === 'max-tokens' ? css.turnNoticeTitleWarn : css.turnNoticeTitle}>{title}</span>
        {message !== '' && <span className={css.turnNoticeMessage}>{message}</span>}
      </div>
      {code !== undefined && code !== 'INTERRUPTED' && <code className={css.turnNoticeCode}>{code}</code>}
    </div>
  )
}

/**
 * Main-conversation-style model selector: a compact trigger showing
 * `model · effort`, opening a two-level menu (provider groups → models, then
 * effort levels). UI mirrors dsh-client-ui-model-selection's ModelSelect.
 */
function ModelSelect(props: {
  directory: SidechatDirectory | null
  selection: ModelSelection
  onSelect: (provider: string, model: string, effort?: string) => void
  t: (key: SidechatLocaleKey) => string
  openSignal?: boolean
  onOpenConsumed?: () => void
}) {
  const { directory, selection, onSelect, t, openSignal, onOpenConsumed } = props
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const rootRef = useRef<HTMLDivElement | null>(null)

  // External open signal (the + command menu asks the selector to open).
  useEffect(() => {
    if (openSignal === true) {
      setPane('root')
      setOpen(true)
      onOpenConsumed?.()
    }
  }, [openSignal, onOpenConsumed])

  // Current model entry across all provider groups.
  let currentChoice: { name: string; reasoning?: DirectoryReasoning } | undefined
  for (const group of directory?.groups ?? []) {
    const model = group.models.find((m) => m.id === selection.model && group.id === selection.provider)
    if (model !== undefined) {
      currentChoice = { name: model.name, reasoning: model.reasoning }
      break
    }
  }
  const reasoning = currentChoice?.reasoning
  const effectiveEffort = selection.effort !== '' ? selection.effort : reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('panel.effortDefault')
      : reasoning.efforts.find((e) => e.id === effectiveEffort)?.name ?? effectiveEffort
  const modelLabel = currentChoice?.name ?? t('panel.noModel')
  const effortChoices = reasoning === undefined
    ? []
    : [
        ...(reasoning.defaultEffort === undefined ? [{ key: 'default', effort: undefined as string | undefined, label: t('panel.effortDefault') }] : []),
        ...reasoning.efforts.map((e) => ({ key: e.id, effort: e.id, label: e.name })),
      ]

  // Close on outside pointer-down / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`

  return (
    <div ref={rootRef} className={css.modelSelect}>
      <button
        type="button"
        className={css.modelSelectTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => {
          if (open) setOpen(false)
          else { setPane('root'); setOpen(true) }
        }}
      >
        <span className={css.modelSelectLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.modelSelectEffort}>{effortLabel}</span>}
        <IconChevronDownOutlineRegular className={open ? css.chevronOpen : undefined} />
      </button>

      {open && (
        <div className={css.modelSelectMenu} role="menu">
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className={css.modelCell} onClick={() => { setPane('model') }}>
                <span className={css.modelCellLabel}>{t('panel.model')}</span>
                <span className={css.modelCellValue}>{modelLabel}</span>
                <IconChevronRightOutlineRegular className={css.modelCellChevron} />
              </button>
              {reasoning !== undefined && (
                <button type="button" role="menuitem" className={css.modelCell} onClick={() => { setPane('effort') }}>
                  <span className={css.modelCellLabel}>{t('panel.effort')}</span>
                  <span className={css.modelCellValue}>{effortLabel}</span>
                  <IconChevronRightOutlineRegular className={css.modelCellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <div className={css.modelGroups}>
              {(directory?.groups ?? []).map((group) => (
                <section key={group.id} role="group" aria-label={group.name} className={css.modelGroup}>
                  <div className={css.modelGroupTitle}>{group.name}</div>
                  {group.models.map((model) => {
                    const selected = selection.provider === group.id && selection.model === model.id
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={selected ? `${css.modelOption} ${css.modelOptionSelected}` : css.modelOption}
                        title={model.name}
                        onClick={() => {
                          onSelect(group.id, model.id)
                          setOpen(false)
                        }}
                      >
                        <span className={css.modelOptionCopy}>
                          <span className={css.modelName}>{model.name}</span>
                          {model.description !== undefined && <span className={css.modelDescription}>{model.description}</span>}
                        </span>
                        <span className={css.modelCheck}>{selected ? <IconCheckOutlineRegular /> : null}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
              {(directory?.groups ?? []).length === 0 && <div className={css.modelEmpty}>{t('panel.noModel')}</div>}
            </div>
          )}

          {pane === 'effort' && (
            <>
              {effortChoices.length === 0
                ? <div className={css.modelEmpty}>{t('panel.effort')}</div>
                : effortChoices.map((level) => {
                    const selected = effectiveEffort === level.effort
                    return (
                      <button
                        key={level.key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={selected ? `${css.modelOption} ${css.modelOptionSelected}` : css.modelOption}
                        onClick={() => {
                          onSelect(selection.provider, selection.model, level.effort)
                          setOpen(false)
                        }}
                      >
                        <span className={css.modelOptionCopy}>
                          <span className={css.modelName}>{level.label}</span>
                        </span>
                        <span className={css.modelCheck}>{selected ? <IconCheckOutlineRegular /> : null}</span>
                      </button>
                    )
                  })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Main-conversation-style permission selector (Menu + compact trigger). */
function PermissionSelect(props: {
  permissions: SidechatPermissions | null
  preset: string
  onSelect: (preset: string) => void
  t: (key: SidechatLocaleKey) => string
  openSignal?: boolean
  onOpenConsumed?: () => void
}) {
  const { permissions, preset, onSelect, openSignal, onOpenConsumed } = props
  const [open, setOpen] = useState(false)
  const options = (permissions?.options ?? []).filter((o) => o.value !== 'custom')
  const current = options.find((o) => o.value === preset)
  const items = options.map((o) => ({ id: o.value, label: o.name }))

  // External open signal (the + command menu asks the selector to open).
  useEffect(() => {
    if (openSignal === true) {
      setOpen(true)
      onOpenConsumed?.()
    }
  }, [openSignal, onOpenConsumed])

  return (
    <Menu
      open={open}
      side="top"
      align="end"
      items={items}
      selectedId={preset}
      onSelect={(id) => { setOpen(false); onSelect(id) }}
      onClose={() => { setOpen(false) }}
      anchor={(
        <button
          type="button"
          className={css.modelSelectTrigger}
          aria-haspopup="menu"
          aria-expanded={open}
          title={current?.description}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.modelSelectLabel}>{current?.name ?? preset}</span>
          <IconChevronDownOutlineRegular />
        </button>
      )}
    />
  )
}

/** Encode text as a Markdown blockquote (one `> ` per line), like DSH's own Quote. */
function toBlockquote(text: string): string {
  return text.split('\n').map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n')
}

/** Focus the side-chat composer once the panel (floating or docked) has mounted. */
function focusSidechatComposer(): void {
  let tries = 0
  const attempt = (): void => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[data-sidechat-input]')
    if (input !== null) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      return
    }
    if (++tries < 30) window.requestAnimationFrame(attempt)
  }
  window.requestAnimationFrame(attempt)
}

/**
 * Stage a selection as a quote in the side-chat composer without sending, so
 * the user can type a prompt under it. `continue` keeps the active (or first)
 * side chat; `new` detaches so the next send creates a fresh side chat.
 * Quoting again into the same target appends another quote.
 */
function stageSelection(store: SidechatStore, parentSessionId: string, text: string, mode: 'new' | 'continue'): void {
  const trimmed = text.trim()
  if (trimmed === '') return
  const before = store.getSnapshot().panel
  const sameParent = before.parentSessionId === parentSessionId || before.parentSessionId === ''
  const target = mode === 'continue' ? (before.activeChildId ?? before.items[0]?.childId ?? null) : null
  store.openPanel(parentSessionId)
  if (target !== null) {
    if (target !== before.activeChildId) {
      store.setActive(target)
      void refreshHistory(store, target)
    }
    const prev = store.getSnapshot().panel.attachment
    store.patch({ attachment: prev === null || prev === '' ? trimmed : `${prev}\n\n${trimmed}` })
  } else {
    const keep = sameParent && before.activeChildId === null && before.attachment !== null && before.attachment !== ''
    store.patch({
      attachment: keep ? `${before.attachment}\n\n${trimmed}` : trimmed,
      activeChildId: null,
      messages: [],
      ...(keep ? {} : { draft: '', provider: '', model: '', effort: '' }),
    })
    if (!keep) {
      void api.inherit({ parentSessionId }).then((result) => {
        if (result.ok) {
          store.patch({
            provider: result.value.provider,
            model: result.value.model,
            effort: result.value.reasoningEffort ?? '',
          })
        }
      })
    }
    void refreshDirectory(store)
  }
  focusSidechatComposer()
}

/** Text-interaction id for the right-click menu on selected chat text. */
const CONTEXT_INTERACTION_ID = 'dsh-side-chat.quote-context'

/** Set once the built-in text-interaction surface hosts our actions (the legacy floating menu then stays off). */
let quoteSurfaceIntegrated = false

/** Props the Chat view passes to `conversation.chat.text-interaction` entries (DSH 0.2.x). */
interface TextInteractionSlotProps {
  trigger?: string
  readText: () => string | null
  dismiss: () => void
  clearSelection: () => void
  inputActions?: { insertQuote?: (text: string) => boolean }
}

/**
 * Selection popup / right-click surface: the built-in "Quote text" (main
 * composer) plus "Quote in side chat" and "Quote in current side chat". Both
 * side-chat actions only stage the quote; nothing is sent.
 */
function QuoteActions(props: TextInteractionSlotProps & {
  store: SidechatStore
  sideT: (key: SidechatLocaleKey) => string
  currentSessionId: () => string | undefined
}) {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  // Panel state is per conversation (the store swaps it on Session change).
  const hasSide = snap.panel.activeChildId !== null || snap.panel.items.length > 0
  const run = (action: (text: string) => void): void => {
    const text = props.readText()
    if (text === null || text.trim() === '') {
      props.dismiss()
      return
    }
    action(text)
    props.clearSelection()
    props.dismiss()
  }
  const toSide = (mode: 'new' | 'continue') => (text: string): void => {
    const id = props.currentSessionId()
    if (id !== undefined) stageSelection(props.store, id, text, mode)
  }
  const insertQuote = props.inputActions?.insertQuote
  const menu = props.trigger === 'contextmenu'
  return (
    <div className={menu ? css.quoteActionsMenu : css.quoteActions} role={menu ? 'menu' : undefined}>
      {insertQuote !== undefined && (
        <button
          type="button"
          role={menu ? 'menuitem' : undefined}
          className={css.quoteAction}
          onPointerDown={(e) => { e.preventDefault() }}
          onClick={() => { run((text) => { insertQuote(text) }) }}
        >
          {props.sideT('quote.main')}
        </button>
      )}
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        className={css.quoteAction}
        onPointerDown={(e) => { e.preventDefault() }}
        onClick={() => { run(toSide('new')) }}
      >
        {props.sideT('quote.side')}
      </button>
      {hasSide && (
        <button
          type="button"
          role={menu ? 'menuitem' : undefined}
          className={css.quoteAction}
          onPointerDown={(e) => { e.preventDefault() }}
          onClick={() => { run(toSide('continue')) }}
        >
          {props.sideT('quote.sideContinue')}
        </button>
      )}
    </div>
  )
}

/**
 * The floating selection menu: listens to the document selection and shows
 * one or two buttons (start / continue), dispatching to the host API.
 */
function SelectionMenu(props: { store: SidechatStore; t: (key: SidechatLocaleKey) => string }) {
  const { anchor, current, panel, prefs } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const [local, setLocal] = useState<SelectionAnchor | null>(null)

  useEffect(() => {
    const compute = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) {
        setLocal(null)
        return
      }
      const text = selection.toString().trim()
      if (text === '') {
        setLocal(null)
        return
      }
      const range = selection.getRangeAt(0)
      const node = range.startContainer
      const element = node.nodeType === 1 ? (node as Element) : node.parentElement
      if (element !== null && element.closest('input, textarea, [contenteditable="true"]') !== null) {
        setLocal(null)
        return
      }
      // Never offer "ask in side chat" for selections inside the side-chat panel
      // (those belong to the bring-back-to-main menu instead).
      if (element !== null && element.closest('[data-dsh-side-chat]') !== null) {
        setLocal(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setLocal(null)
        return
      }
      setLocal({ text, x: rect.left + rect.width / 2, y: rect.top })
    }
    const onMouseUp = (): void => { window.setTimeout(compute, 0) }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', compute)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', compute)
    }
  }, [])

  const start = useCallback(() => {
    if (local === null || current === undefined) return
    const parentSessionId = current
    const text = local.text
    const snap = props.store.getSnapshot().panel
    if (prefs.sendImmediately) {
      const content: PromptContentPart[] = [
        { type: 'text', text },
        ...(prefs.defaultPrompt.trim() !== '' ? [{ type: 'text' as const, text: prefs.defaultPrompt.trim() }] : []),
      ]
      void api.start({
        parentSessionId,
        content,
        lookupEnabled: prefs.lookupDefault,
        ...(snap.provider !== '' ? { provider: snap.provider } : {}),
        ...(snap.model !== '' ? { model: snap.model } : {}),
        ...(snap.effort !== '' ? { reasoningEffort: snap.effort } : {}),
      }).then((result) => {
        if (result.ok) {
          props.store.openPanel(parentSessionId)
          props.store.setActive(result.value.childId)
          props.store.patch({
            provider: result.value.provider,
            model: result.value.model,
            effort: result.value.reasoningEffort ?? '',
          })
          void refreshList(props.store, parentSessionId)
          void refreshDirectory(props.store)
        }
      })
    } else {
      stageSelection(props.store, parentSessionId, text, 'new')
    }
    setLocal(null)
  }, [local, current, prefs, props.store])

  const continueChat = useCallback(() => {
    if (local === null || current === undefined) return
    const parentSessionId = current
    const text = local.text
    const active = props.store.getSnapshot().panel.activeChildId
    if (active === null) return
    props.store.openPanel(parentSessionId)
    if (prefs.sendImmediately) {
      const content: PromptContentPart[] = [
        { type: 'text', text },
        ...(prefs.defaultPrompt.trim() !== '' ? [{ type: 'text' as const, text: prefs.defaultPrompt.trim() }] : []),
      ]
      setItemRunning(props.store, active, true)
      void api.followup({ childId: active, content, lookupEnabled: prefs.lookupDefault }).then((result) => {
        if (!result.ok) props.store.patch({ error: result.error.message })
        void refreshList(props.store, parentSessionId)
        void refreshHistory(props.store, active)
      })
    } else {
      stageSelection(props.store, parentSessionId, text, 'continue')
    }
    setLocal(null)
  }, [local, current, prefs, props.store])

  if (local === null || current === undefined) return null
  const hasActive = panel.activeChildId !== null
  return (
    <div className={css.selectionMenu} style={{ left: local.x, top: local.y - 46 }}>
      <button type="button" className={css.selectionButton} onClick={start}>{props.t('ask.new')}</button>
      {hasActive && <button type="button" className={css.selectionButton} onClick={continueChat}>{props.t('ask.continue')}</button>}
    </div>
  )
}

/**
 * The floating bring-back-to-main menu: listens to the document selection and,
 * when the selection is inside an assistant reply in the side-chat panel, shows
 * two actions — "insert directly" and "summarize then insert" — both appending
 * into the main composer without sending.
 */
function BringBackMenu(props: {
  store: SidechatStore
  t: (key: SidechatLocaleKey) => string
  bringToMain: (text: string) => Promise<boolean>
  summarizeBring: (text: string) => Promise<boolean>
}) {
  const [local, setLocal] = useState<SelectionAnchor | null>(null)
  const [summarizing, setSummarizing] = useState(false)

  useEffect(() => {
    const compute = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) {
        setLocal(null)
        return
      }
      const text = selection.toString().trim()
      if (text === '') {
        setLocal(null)
        return
      }
      const range = selection.getRangeAt(0)
      const node = range.startContainer
      const element = node.nodeType === 1 ? (node as Element) : node.parentElement
      if (element !== null && element.closest('input, textarea, [contenteditable="true"]') !== null) {
        setLocal(null)
        return
      }
      if (element === null || element.closest('[data-sidechat-role="assistant"]') === null) {
        setLocal(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setLocal(null)
        return
      }
      setLocal({ text, x: rect.left + rect.width / 2, y: rect.top })
    }
    const onMouseUp = (): void => { window.setTimeout(compute, 0) }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', compute)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', compute)
    }
  }, [])

  if (local === null) return null

  const summarize = async (): Promise<void> => {
    setSummarizing(true)
    const ok = await props.summarizeBring(local.text)
    setSummarizing(false)
    if (!ok) props.store.patch({ error: props.t('insert.summarizeFailed') })
    else setLocal(null)
  }

  return (
    <div className={css.selectionMenu} style={{ left: local.x, top: local.y - 46 }}>
      <button
        type="button"
        className={css.selectionButton}
        onClick={() => {
          void props.bringToMain(local.text).then((ok) => {
            if (!ok) props.store.patch({ error: props.t('insert.failed') })
            else setLocal(null)
          })
        }}
      >
        {props.t('insert.direct')}
      </button>
      <button type="button" className={css.selectionButton} disabled={summarizing} onClick={() => { void summarize() }}>
        {summarizing ? props.t('insert.summarizing') : props.t('insert.summarize')}
      </button>
    </div>
  )
}

/**
 * Floating entry shown while the panel is closed and the main conversation has
 * a pending question dialog. It anchors beside the dialog's header (without
 * covering its text) and disappears once clicked (the panel opens instead).
 */
function QuestionFab(props: {
  store: SidechatStore
  t: (key: SidechatLocaleKey) => string
  onOpen: () => void
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    let raf = 0
    let missing = 0
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>('[data-question-key], [data-approval-key]')
      if (el === null) {
        missing += 1
        // A brief grace period covers the initial render; if the dialog stays
        // absent, clear the tracked question so this entry disappears too.
        if (missing > 30) {
          props.store.setMainQuestion(null)
          return
        }
        setPos(null)
        raf = requestAnimationFrame(tick)
        return
      }
      missing = 0
      // The dialog's header (its title/eyebrow block) is the anchor. Newer DSH
      // wraps it as `section > header` inside the data-question frame, so locate
      // the `header` tag generically (older builds had it as the first child).
      const header = el.querySelector<HTMLElement>('header') ?? (el.firstElementChild as HTMLElement | null) ?? el
      const rect = header.getBoundingClientRect()
      const size = 32
      const left = Math.min(rect.right + 8, window.innerWidth - size - 8)
      const top = rect.top + rect.height / 2
      setPos({ left, top })
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelAnimationFrame(raf) }
  }, [props.store])

  const style: CSSProperties = pos !== null
    ? { left: pos.left, top: pos.top, transform: 'translateY(-50%)' }
    : { left: '50%', bottom: 160, transform: 'translateX(-50%)' }

  return (
    <Tooltip label={props.t('question.openHint')} side="top">
      <button
        type="button"
        className={css.questionFab}
        style={style}
        aria-label={props.t('question.openHint')}
        onClick={props.onOpen}
      >
        <IconPanelLeftOutlineRegular size={16} />
        <span className={css.questionFabDot} />
      </button>
    </Tooltip>
  )
}

/** Panel width bounds. The panel never takes more than ~40% of the window and
 * never squeezes the main chat below a usable minimum — so the panel adapts to
 * whatever resolution / zoom the browser window is at. */
const PANEL_MIN_WIDTH = 280
const PANEL_MAX_WIDTH = 720
const PANEL_DEFAULT_WIDTH = 360
const MAIN_CHAT_MIN_WIDTH = 480
/** localStorage key remembering the last panel width across reloads. */
const PANEL_WIDTH_KEY = 'dsh-side-chat.panelWidth'

/** Right-sidebar dock identity (kind is the `openTab` discriminator; id keys the body seat). */
const SIDEBAR_TAB_ID = 'dsh-side-chat-plus/side-chat'
const SIDEBAR_TAB_KIND = 'side-chat'

/** The viewport-aware maximum panel width for the current window. */
function panelCap(): number {
  const vw = window.innerWidth
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, vw * 0.4, vw - MAIN_CHAT_MIN_WIDTH))
}

/** The last user-chosen width, if any (re-clamped to the viewport on load). */
function savedPanelWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * The side chat's own `ask_user_question` card.
 *
 * The host renders its question card into the `conversation.composer` slot,
 * which exists only for the main conversation — so a question asked by a SIDE
 * chat agent reached no surface and blocked the turn until it was aborted.
 * This card gives the side panel the same answering surface: one batch over
 * every question, single- or multi-select plus a free-text answer, Skip per
 * question, and one submit through the carrier's live channel.
 */
function SideQuestionCard(props: {
  request: SideQuestionRequest
  t: (key: SidechatLocaleKey) => string
  onSettled: () => void
  onError: (message: string) => void
}) {
  const { request } = props
  /** Selected option labels per question id. */
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  /** Free-text answer per question id. */
  const [custom, setCustom] = useState<Record<string, string>>({})
  /** Question ids the user explicitly skipped. */
  const [skipped, setSkipped] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  // A new request (different key) starts from a clean draft. Options marked
  // "(Recommended)" start selected, mirroring the host card's preselection.
  useEffect(() => {
    const preset: Record<string, string[]> = {}
    for (const q of request.questions) {
      const recommended = (q.options ?? [])
        .filter((o) => /\(Recommended\)\s*$/i.test(o.label))
        .map((o) => o.label)
      if (recommended.length === 0) continue
      preset[q.id] = q.multiSelect === true ? recommended : recommended.slice(0, 1)
    }
    setSelected(preset)
    setCustom({})
    setSkipped([])
    setSubmitting(false)
    // Keyed on the request identity ONLY. `request.questions` is a fresh array
    // on every republish, so depending on it reset the draft (and cleared
    // `submitting`) mid-submit. The card is also mounted under `key={key}`, so
    // a different request gets a fresh component anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.key])

  const toggle = (q: SideQuestionItem, label: string): void => {
    setSkipped((s) => s.filter((id) => id !== q.id))
    setSelected((prev) => {
      const current = prev[q.id] ?? []
      if (q.multiSelect === true) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
        return { ...prev, [q.id]: next }
      }
      // Single-select: clicking the chosen option again clears it.
      return { ...prev, [q.id]: current[0] === label ? [] : [label] }
    })
  }

  const skip = (q: SideQuestionItem): void => {
    setSkipped((s) => (s.includes(q.id) ? s.filter((id) => id !== q.id) : [...s, q.id]))
    setSelected((prev) => ({ ...prev, [q.id]: [] }))
    setCustom((prev) => ({ ...prev, [q.id]: '' }))
  }

  /** Every question has a selection, a free-text answer, or an explicit skip. */
  const complete = request.questions.every((q) => {
    if (skipped.includes(q.id)) return true
    if ((selected[q.id] ?? []).length > 0) return true
    return (custom[q.id] ?? '').trim() !== ''
  })

  const submit = (): void => {
    if (submitting || !complete) return
    setSubmitting(true)
    const answers = request.questions.map((q) => {
      const text = (custom[q.id] ?? '').trim()
      // A skip is the agreed blank shape: empty `selected`, no `custom`.
      if (skipped.includes(q.id)) return { id: q.id, selected: [] }
      const labels = selected[q.id] ?? []
      // Single-select: free text replaces the choice. Multi-select: it adds to it.
      if (text !== '' && q.multiSelect !== true) return { id: q.id, selected: [], custom: text }
      return text === '' ? { id: q.id, selected: labels } : { id: q.id, selected: labels, custom: text }
    })
    // Retire the card FIRST. Answering through the live waterfall settles it
    // synchronously, which republishes the carrier and tears this component
    // down from inside its own handler; doing the bookkeeping afterwards ran
    // against an unmounted card and left the panel wedged.
    props.onSettled()
    void Promise.resolve()
      .then(() => request.answer({ answers }))
      .catch((error: unknown) => {
        props.onError(error instanceof Error ? error.message : String(error))
      })
  }

  return (
    <div className={css.sideQuestion} data-testid="sidechat-question" role="group" aria-label={props.t('sideQuestion.title')}>
      <div className={css.sideQuestionHeader}>
        <span className={css.sideQuestionDot} />
        <span className={css.sideQuestionTitle}>{props.t('sideQuestion.title')}</span>
      </div>
      {request.questions.map((q) => {
        const isSkipped = skipped.includes(q.id)
        const chosen = selected[q.id] ?? []
        return (
          <div key={q.id} className={css.sideQuestionItem} data-skipped={isSkipped ? '1' : undefined}>
            {q.header !== undefined && q.header !== '' && (
              <div className={css.sideQuestionItemHeader}>{q.header}</div>
            )}
            <div className={css.sideQuestionText}>{q.question}</div>
            {q.detail !== undefined && q.detail !== '' && (
              <div className={css.sideQuestionDetail}>{q.detail}</div>
            )}
            {(q.options ?? []).length > 0 && (
              <div className={css.sideQuestionOptions}>
                {(q.options ?? []).map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    className={css.sideQuestionOption}
                    data-selected={chosen.includes(o.label) ? '1' : undefined}
                    aria-pressed={chosen.includes(o.label)}
                    disabled={submitting}
                    onClick={() => { toggle(q, o.label) }}
                  >
                    <span className={css.sideQuestionOptionLabel}>{o.label}</span>
                    {o.description !== undefined && o.description !== '' && (
                      <span className={css.sideQuestionOptionDesc}>{o.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className={css.sideQuestionRow}>
              <input
                type="text"
                className={css.sideQuestionCustom}
                placeholder={props.t('sideQuestion.customPlaceholder')}
                value={custom[q.id] ?? ''}
                disabled={submitting || isSkipped}
                onChange={(e) => {
                  const value = e.target.value
                  setSkipped((s) => s.filter((id) => id !== q.id))
                  setCustom((prev) => ({ ...prev, [q.id]: value }))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
                }}
              />
              <button
                type="button"
                className={css.sideQuestionSkip}
                data-selected={isSkipped ? '1' : undefined}
                disabled={submitting}
                onClick={() => { skip(q) }}
              >
                {props.t('sideQuestion.skip')}
              </button>
            </div>
          </div>
        )
      })}
      <div className={css.sideQuestionActions}>
        <button
          type="button"
          className={css.sideQuestionSubmit}
          disabled={submitting || !complete}
          onClick={submit}
          data-testid="sidechat-question-submit"
        >
          {submitting ? props.t('sideQuestion.submitting') : props.t('sideQuestion.submit')}
        </button>
      </div>
    </div>
  )
}

/** The side-chat panel body. */
function SidechatPanel(props: {
  store: SidechatStore
  t: (key: SidechatLocaleKey) => string
  formatDuration: (ms: number) => string
  bringToMain: (text: string) => Promise<boolean>
  summarizeBring: (text: string) => Promise<boolean>
  askSidechat: (text: string) => Promise<boolean>
  askSidechatNew: (text: string) => Promise<boolean>
  /** Render inside the built-in right sidebar's tab pane (no floating chrome). */
  embedded?: boolean
  /** A built-in sidebar overlay (fullscreen preview / floating panel) owns the viewport: hide this panel. */
  conflictHidden?: boolean
}) {
  const { panel, mainQuestion, sideQuestion, dismissedQuestionIds } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  /**
   * Whether this panel is on screen. The docked panel is mounted only while its
   * sidebar tab shows, and stays there after a page reload or app restart with
   * `panel.open` false (that flag belongs to the floating panel). Gating the
   * transcript polling on `panel.open` alone left a docked side chat frozen:
   * a sent message stayed on "Sending…" and the reply never appeared.
   */
  const shown = props.embedded === true || panel.open
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: props.t('panel.copy'), copiedLabel: props.t('panel.copied') },
    footnotes: props.t('panel.footnotes'),
  }), [props.t])
  const attachmentRailLabels = useMemo(() => ({
    group: props.t('image.railGroup'),
    open: props.t('image.railOpen'),
    scrollLeft: props.t('image.railScrollLeft'),
    scrollRight: props.t('image.railScrollRight'),
  }), [props.t])
  const messageImageLabels = useMemo(() => ({
    image: props.t('image.label'),
    open: props.t('image.open'),
    openNamed: (name: string): string => name,
    loading: props.t('image.loading'),
    loadFailed: props.t('image.loadFailed'),
    lightbox: { dialog: props.t('image.lightboxDialog'), close: props.t('image.close') },
  }), [props.t])
  const dropOverlayLabels = useMemo(() => ({
    title: props.t('image.dropTitle'),
    desc: props.t('image.dropDesc'),
  }), [props.t])
  // Width starts at the user's last choice when it fits the current window,
  // otherwise adapts to the viewport (small screens get a smaller default).
  const [width, setWidth] = useState(() => {
    const base = savedPanelWidth() ?? PANEL_DEFAULT_WIDTH
    return Math.max(PANEL_MIN_WIDTH, Math.min(panelCap(), base))
  })
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [dragActive, setDragActive] = useState(false)
  const [lightbox, setLightbox] = useState<ComposerAttachment | null>(null)
  const [limits, setLimits] = useState<{ mediaTypes: string[]; maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number; maxImagePixels: number; maxImageDimension?: number } | null>(null)
  /** Index of the assistant message whose "summarize then insert" is in flight. */
  const [summarizingIndex, setSummarizingIndex] = useState<number | null>(null)
  /** Which question-dialog item is being brought into the side chat ('all' or an option label). */
  const [bringingKey, setBringingKey] = useState<string | null>(null)
  /** Whether the question-dialog list is collapsed (headers only). */
  const [questionCollapsed, setQuestionCollapsed] = useState(false)
  /** Local echoes of sent messages the transcript has not recorded yet. */
  const [pending, setPending] = useState<PendingEcho[]>([])
  /** Whether the transcript follows new output (true while the reader sits at the bottom). */
  const followRef = useRef(true)

  // Auto-expand the panel whenever a side chat is started or activated, so
  // starting from a collapsed panel still reveals the conversation.
  useEffect(() => {
    if (panel.open && panel.activeChildId !== null) setCollapsed(false)
  }, [panel.open, panel.activeChildId])

  // Open (and expand) the panel to show the pending question dialog.
  const openQuestionPanel = useCallback(() => {
    props.store.openPanel(panel.parentSessionId)
    setCollapsed(false)
  }, [props.store, panel.parentSessionId])

  /** Assemble one question + all its options into a prompt. */
  const buildAllText = (q: SideQuestionItem): string => {
    const lines: string[] = []
    if (q.header !== undefined && q.header !== '') lines.push(`【${q.header}】`)
    lines.push(q.question)
    if (q.detail !== undefined && q.detail !== '') lines.push(q.detail)
    const options = q.options ?? []
    if (options.length > 0) {
      lines.push(props.t('question.options'))
      for (const o of options) {
        lines.push(`- ${o.label}${o.description !== undefined && o.description !== '' ? ` — ${o.description}` : ''}`)
      }
    }
    lines.push(props.t('question.allPrompt'))
    return lines.join('\n')
  }

  /** Assemble one question + one specific option into a prompt. */
  const buildOneText = (q: SideQuestionItem, o: SideQuestionOption): string => {
    const lines: string[] = []
    if (q.header !== undefined && q.header !== '') lines.push(`【${q.header}】`)
    lines.push(q.question)
    if (q.detail !== undefined && q.detail !== '') lines.push(q.detail)
    lines.push(`${props.t('question.option')}：${o.label}${o.description !== undefined && o.description !== '' ? ` — ${o.description}` : ''}`)
    lines.push(props.t('question.onePrompt'))
    return lines.join('\n')
  }

  const bringQuestionText = (text: string, key: string, useNew: boolean): void => {
    setBringingKey(key)
    const fn = useNew ? props.askSidechatNew : props.askSidechat
    void fn(text).then((ok) => {
      setBringingKey(null)
      if (!ok) props.store.patch({ error: props.t('question.failed') })
    })
  }

  const activeItem = panel.items.find((i) => i.childId === panel.activeChildId)
  const activeRunning = activeItem?.running ?? false
  /** The composer holds something sendable (text, a quote, or images). */
  const hasDraft = panel.draft.trim() !== '' || (panel.attachment !== null && panel.attachment.trim() !== '') || panel.attachments.length > 0
  const [anchor, setAnchor] = useState<number | null>(null)

  useEffect(() => {
    if (props.embedded) return
    const w = panel.open && !collapsed && !props.conflictHidden ? `${width}px` : '0px'
    document.documentElement.style.setProperty('--dsh-subchat-width', w)
    return () => { document.documentElement.style.setProperty('--dsh-subchat-width', '0px') }
  }, [props.embedded, panel.open, collapsed, width, props.conflictHidden])

  // Re-adapt the panel width when the window is resized: if the viewport
  // shrinks (smaller window, different monitor, higher zoom), the panel is
  // clamped to the new cap and the layout margin follows via the effect above.
  useEffect(() => {
    const onResize = (): void => {
      setWidth((w) => Math.min(w, panelCap()))
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  // Remember the width across reloads; on the next load it is re-clamped to
  // whatever window is present then.
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(width))
    } catch {
      // Storage unavailable (private mode etc.) — the width just won't persist.
    }
  }, [width])

  // Lazy-load the model/permission directory whenever the panel is open but the
  // directory has not hydrated yet (covers page reload + continue + direct open).
  useEffect(() => {
    if (shown && panel.directory === null) {
      void refreshDirectory(props.store)
    }
  }, [shown, panel.directory, props.store])

  useEffect(() => {
    if (activeRunning) {
      if (anchor === null) setAnchor(activeItem?.runningSince ?? Date.now())
    } else if (anchor !== null) {
      setAnchor(null)
    }
  }, [activeRunning, activeItem?.runningSince, anchor])

  useEffect(() => {
    if (!activeRunning) return
    const id = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(id) }
  }, [activeRunning])

  // Switching side chats starts at the bottom and drops the other chat's echoes.
  useEffect(() => {
    followRef.current = true
    setPending([])
  }, [panel.activeChildId])

  // Like the main chat: follow new output only while the reader is at the
  // bottom. Scrolling up stops following; scrolling back down resumes it.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current
    if (el === null) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX
  }, [])

  // Match local echoes against the recorded transcript; a matched echo is gone.
  const visiblePending = useMemo(() => unresolvedEchoes(pending, panel.messages), [pending, panel.messages])
  useEffect(() => {
    if (visiblePending.length !== pending.length) setPending(visiblePending)
  }, [visiblePending, pending.length])

  // An echo whose message never landed (the turn was stopped and its queue
  // cleared) is dropped once the side chat has stayed idle for a while.
  useEffect(() => {
    if (activeRunning || pending.length === 0) return
    const id = window.setTimeout(() => {
      const cutoff = Date.now() - STALE_ECHO_MS
      setPending((list) => list.filter((p) => p.sentAt > cutoff))
    }, STALE_ECHO_MS)
    return () => { window.clearTimeout(id) }
  }, [activeRunning, pending])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight
  }, [panel.messages, panel.activeChildId, visiblePending.length, activeRunning, panel.error])

  useEffect(() => {
    if (!shown || panel.activeChildId === null) return
    const tick = (): void => {
      const snap = props.store.getSnapshot().panel
      const childId = snap.activeChildId
      if (childId === null) return
      void refreshList(props.store, snap.parentSessionId)
      void refreshHistory(props.store, childId)
    }
    tick()
    const id = window.setInterval(tick, 1200)
    return () => { window.clearInterval(id) }
  }, [shown, panel.activeChildId, props.store])

  /**
   * Send the composer. While the side chat runs, the default pushes the
   * message into the running turn (steer); `queue` holds it for the next turn,
   * like the main chat's Cmd/Ctrl+Enter.
   */
  const send = useCallback((runningMode: 'queue' | 'steer' = 'steer') => {
    const draft = panel.draft.trim()
    // The highlighted text staged as a quote; a new side chat is named after it.
    const quoted = panel.attachment === null ? '' : panel.attachment.trim()
    const attachment = quoted === '' ? '' : toBlockquote(quoted)
    const text = attachment === '' ? draft : (draft === '' ? attachment : `${attachment}\n\n${draft}`)
    void serializeImages(panel.attachments).then((imageParts) => {
      const content: PromptContentPart[] = [...imageParts, ...(text === '' ? [] : [{ type: 'text', text }] as PromptContentPart[])]
      if (content.length === 0) return
      const toRelease = panel.attachments
      props.store.patch({ draft: '', attachment: null, attachments: [] })
      toRelease.forEach(releaseDraftImage)

      if (panel.activeChildId === null) {
        void api.start({
          parentSessionId: panel.parentSessionId,
          content,
          lookupEnabled: panel.lookup,
          ...(panel.provider !== '' ? { provider: panel.provider } : {}),
          ...(panel.model !== '' ? { model: panel.model } : {}),
          ...(panel.effort !== '' ? { reasoningEffort: panel.effort } : {}),
          ...(panel.preset !== '' ? { preset: panel.preset } : {}),
          ...(quoted !== '' ? { name: quoted } : {}),
        }).then((result) => {
          if (result.ok) {
            props.store.setActive(result.value.childId)
            props.store.patch({
              provider: result.value.provider,
              model: result.value.model,
              effort: result.value.reasoningEffort ?? '',
            })
            void refreshList(props.store, panel.parentSessionId)
            void refreshDirectory(props.store)
          } else {
            props.store.patch({ error: result.error.message })
          }
        })
        return
      }

      const childId = panel.activeChildId
      const mode: PendingEcho['mode'] = activeRunning ? runningMode : 'send'
      const echo: PendingEcho = {
        id: `echo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text,
        images: imageParts.length,
        mode,
        baseline: userMessageCount(panel.messages),
        sentAt: Date.now(),
      }
      // Your own message always brings the transcript back to the bottom.
      followRef.current = true
      setPending((list) => [...list, echo])
      setItemRunning(props.store, childId, true)
      const deliver = mode === 'steer' ? api.steer : api.followup
      void deliver({ childId, content, lookupEnabled: panel.lookup }).then((result) => {
        if (!result.ok) {
          setPending((list) => list.filter((p) => p.id !== echo.id))
          if (!activeRunning) setItemRunning(props.store, childId, false)
          props.store.patch({ error: result.error.message })
        }
        void refreshList(props.store, panel.parentSessionId)
        void refreshHistory(props.store, childId)
      })
    }).catch((error: unknown) => {
      props.store.patch({ error: error instanceof Error ? error.message : String(error) })
    })
  }, [panel, props.store, activeRunning])

  const stop = useCallback(() => {
    if (panel.activeChildId === null) return
    const childId = panel.activeChildId
    setItemRunning(props.store, childId, false)
    // Stopping clears the side chat's queued and steering messages on the host.
    setPending([])
    void api.stop({ childId }).then(() => {
      void refreshList(props.store, panel.parentSessionId)
      void refreshHistory(props.store, childId)
    })
  }, [panel, props.store])

  const onModelSelect = useCallback((provider: string, model: string, effort?: string) => {
    // Always update the panel selection; only a live child can receive the
    // selection immediately (staged mode applies it at creation instead).
    props.store.patch({ provider, model, effort: effort ?? '' })
    if (panel.activeChildId !== null) {
      void api.selectModel({ childId: panel.activeChildId, provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    }
  }, [panel.activeChildId, props.store])

  const onPresetChange = useCallback((value: string) => {
    if (value === 'custom' || value === '') return
    props.store.patch({ preset: value })
    if (panel.activeChildId !== null) {
      void api.selectPermission({ childId: panel.activeChildId, presetName: value }).then((result) => {
        if (!result.ok) props.store.patch({ error: result.error.message })
      })
    }
  }, [panel.activeChildId, props.store])

  const dispose = useCallback(() => {
    if (panel.activeChildId === null) return
    const childId = panel.activeChildId
    void api.dispose({ childId }).then(() => {
      void refreshList(props.store, panel.parentSessionId)
      props.store.patch({ activeChildId: null, messages: [] })
    })
  }, [panel, props.store])

  /** Delete one side chat from the list. */
  const disposeItem = useCallback((childId: string) => {
    void api.dispose({ childId }).then(() => {
      void refreshList(props.store, panel.parentSessionId)
      if (panel.activeChildId === childId) {
        props.store.patch({ activeChildId: null, messages: [] })
      }
    })
  }, [panel.activeChildId, panel.parentSessionId, props.store])

  /** Rename one side chat (empty clears the name); optimistic, then re-listed. */
  const renameItem = useCallback((childId: string, raw: string) => {
    const name = raw.replace(/\s+/g, ' ').trim()
    const items = props.store.getSnapshot().panel.items
    props.store.patch({
      items: items.map((i) => {
        if (i.childId !== childId) return i
        const { name: _old, ...rest } = i
        return name === '' ? rest : { ...rest, name }
      }),
    })
    const parentSessionId = panel.parentSessionId
    void api.rename({ childId, name }).then((result) => {
      if (!result.ok) props.store.patch({ error: result.error.message })
      void refreshList(props.store, parentSessionId)
    })
  }, [panel.parentSessionId, props.store])

  /** Bring one past side chat back into this conversation's list and open it. */
  const openPast = useCallback((item: SidechatPastItem) => {
    const parentSessionId = panel.parentSessionId
    void (async () => {
      if (item.status !== 'listed') {
        const result = await api.reopen({ childId: item.childId, parentSessionId })
        if (!result.ok) {
          props.store.patch({ error: `${props.t('past.failed')}: ${result.error.message}` })
          return
        }
      }
      await refreshList(props.store, parentSessionId)
      props.store.setActive(item.childId)
      props.store.patch({ pastOpen: false })
      void refreshHistory(props.store, item.childId)
    })()
  }, [panel.parentSessionId, props.store, props.t])

  /** Delete every side chat of this conversation at once. */
  const disposeAll = useCallback(() => {
    const ids = panel.items.map((i) => i.childId)
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => api.dispose({ childId: id }))).then(() => {
      void refreshList(props.store, panel.parentSessionId)
      props.store.patch({ activeChildId: null, messages: [] })
    })
  }, [panel.items, panel.parentSessionId, props.store])

  const startResize = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: globalThis.MouseEvent): void => {
      setWidth(Math.max(PANEL_MIN_WIDTH, Math.min(panelCap(), startWidth + (startX - ev.clientX))))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [width])

  const intakeImages = useCallback((files: File[]) => {
    if (files.length === 0) return
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) {
      props.store.patch({ error: props.t('image.unsupported') })
      return
    }
    void (async () => {
      try {
        if (limits !== null) {
          if (images.some((f) => !limits.mediaTypes.includes(f.type))) {
            props.store.patch({ error: props.t('image.unsupported') })
            return
          }
          if (panel.attachments.length + images.length > limits.maxImagesPerMessage) {
            props.store.patch({ error: props.t('image.tooMany') })
            return
          }
          if (images.some((f) => f.size > limits.maxImageBytes)) {
            props.store.patch({ error: props.t('image.fileTooLarge') })
            return
          }
          // DSH 0.1.6 added a per-image intrinsic width/height ceiling; older
          // lines omit it. Decoding is async, so this check is awaited rather
          // than folded into the size-type ones above.
          const maxDimension = limits.maxImageDimension
          if (typeof maxDimension === 'number' && maxDimension > 0) {
            for (const file of images) {
              const size = await imageSize(file)
              if (size !== null && (size.width > maxDimension || size.height > maxDimension)) {
                props.store.patch({ error: props.t('image.dimensionTooLarge') })
                return
              }
            }
          }
        }
        const created = createDraftImages(images)
        props.store.patch({ attachments: [...panel.attachments, ...created], error: null })
      } catch (error) {
        props.store.patch({ error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }, [limits, panel.attachments, props.store, props.t])

  // Load the deployment image policy once (fast-path checks mirror the host).
  useEffect(() => {
    void api.limits().then((result) => {
      if (result.ok) setLimits(result.value)
    })
  }, [])

  // Full-page file drag: track enter/leave depth and accept image drops.
  useEffect(() => {
    if (!panel.open || collapsed) return
    const dragDepth = { value: 0 }
    const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false
    const reset = (): void => { dragDepth.value = 0; setDragActive(false) }
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.value += 1
      setDragActive(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event) || event.dataTransfer === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      dragDepth.value = Math.max(0, dragDepth.value - 1)
      if (dragDepth.value === 0) setDragActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
      intakeImages([...event.dataTransfer?.files ?? []])
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [panel.open, collapsed, intakeImages])

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    intakeImages(files)
  }, [intakeImages])

  const removeImage = useCallback((id: string) => {
    const target = panel.attachments.find((a) => a.id === id)
    if (target !== undefined) releaseDraftImage(target)
    props.store.patch({ attachments: panel.attachments.filter((a) => a.id !== id) })
  }, [panel.attachments, props.store])

  // Load one durable image's bytes → object URL for history rendering.
  const imageLoader: ImageLoader = useCallback(async (ref) => {
    const result = await api.attachment({ childId: panel.activeChildId ?? '', attachmentId: ref.attachmentId })
    if (!result.ok) throw new Error(result.error.message)
    return base64ObjectUrl(result.value.mediaType, result.value.data)
  }, [panel.activeChildId])

  // The pending-question entry floats in the portal (SideChatShell), where it is
  // mounted in both modes; only the floating-mode collapsed handle still lives
  // here, next to the collapsed state it belongs to.
  if (!props.embedded) {
    if (!panel.open) return null

    if (collapsed) {
      // Collapsed but a question dialog is pending: keep the floating entry so it
      // can still be opened from beside the dialog (not just the collapsed handle).
      if (mainQuestion !== null) {
        return <QuestionFab store={props.store} t={props.t} onOpen={openQuestionPanel} />
      }
      // Collapsed handle: a floating round button on the right edge.
      return (
        <Tooltip label={props.t('panel.expand')} side="bottom">
          <button type="button" className={css.collapsedHandle} onClick={() => { setCollapsed(false) }}>
            <IconPanelLeftOutlineRegular size={16} />
          </button>
        </Tooltip>
      )
    }
  }

  const elapsedMs = anchor === null ? 0 : Math.max(0, now - anchor)
  const showClock = elapsedMs >= 15000

  const panelClass = props.embedded
    ? `${css.panel} ${css.panelEmbedded}`
    : `${css.panel}${props.conflictHidden ? ` ${css.panelConflictHidden}` : ''}`

  return (
    <div
      className={panelClass}
      style={props.embedded ? undefined : { width }}
      data-sidechat-panel={props.embedded ? 'embedded' : 'floating'}
    >
      {!props.embedded && <div className={css.panelResize} onMouseDown={startResize} />}
      {!props.embedded && (
        <div className={css.panelHeader}>
          <span className={css.panelTitle}>{props.t('panel.title')}</span>
          <div className={css.panelHeaderActions}>
            <Tooltip label={props.t('panel.collapse')} side="bottom">
              <button type="button" className={css.panelIconButton} onClick={() => { setCollapsed(true) }}>
                <IconPanelLeftOutlineRegular size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {mainQuestion !== null && (() => {
        const visible = mainQuestion.filter((q) => !dismissedQuestionIds.includes(q.id))
        if (visible.length === 0) return null
        return (
          <div className={css.questionBlock}>
            <div className={css.questionBlockActions}>
              <button
                type="button"
                className={css.questionToggle}
                onClick={() => { setQuestionCollapsed(!questionCollapsed) }}
              >
                {questionCollapsed ? props.t('question.expand') : props.t('question.collapse')}
              </button>
              <button
                type="button"
                className={css.questionDeleteAll}
                onClick={() => { props.store.dismissAllQuestions(visible.map((q) => q.id)) }}
              >
                {props.t('question.deleteAll')}
              </button>
            </div>
            {visible.map((q) => {
              if (questionCollapsed) {
                return (
                  <div key={q.id} className={`${css.questionItem} ${css.questionItemCollapsed}`}>
                    <span className={css.questionHeaderText}>{q.header ?? q.question}</span>
                  </div>
                )
              }
              const options = q.options ?? []
              return (
                <div key={q.id} className={css.questionItem}>
                  <div className={css.questionHeader}>
                    <span className={css.questionHeaderText}>{q.header ?? q.question}</span>
                    <div className={css.questionHeaderActions}>
                      <button
                        type="button"
                        className={css.questionBringButton}
                        disabled={bringingKey !== null}
                        onClick={() => { bringQuestionText(buildAllText(q), `newall:${q.id}`, true) }}
                      >
                        {bringingKey === `newall:${q.id}` ? props.t('question.bringing') : props.t('question.bringAllNew')}
                      </button>
                      <button
                        type="button"
                        className={css.questionBringButton}
                        disabled={bringingKey !== null}
                        onClick={() => { bringQuestionText(buildAllText(q), `all:${q.id}`, false) }}
                      >
                        {bringingKey === `all:${q.id}` ? props.t('question.bringing') : props.t('question.bringAll')}
                      </button>
                      <button
                        type="button"
                        className={css.questionDelete}
                        aria-label={props.t('question.delete')}
                        title={props.t('question.delete')}
                        onClick={() => { props.store.dismissQuestion(q.id) }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className={css.questionBody}>{q.question}</div>
                  {q.detail !== undefined && q.detail !== '' && <div className={css.questionDetail}>{q.detail}</div>}
                  {options.map((o) => {
                    const key = `${q.id}:${o.label}`
                    return (
                      <div key={o.label} className={css.questionOption}>
                        <span className={css.questionOptionText}>
                          <span className={css.questionOptionLabel}>{o.label}</span>
                          {o.description !== undefined && o.description !== '' && <span className={css.questionOptionDesc}> — {o.description}</span>}
                        </span>
                        <button
                          type="button"
                          className={css.questionBringButton}
                          disabled={bringingKey !== null}
                          onClick={() => { bringQuestionText(buildOneText(q, o), `new:${key}`, true) }}
                        >
                          {bringingKey === `new:${key}` ? props.t('question.bringing') : props.t('question.bringOneNew')}
                        </button>
                        <button
                          type="button"
                          className={css.questionBringButton}
                          disabled={bringingKey !== null}
                          onClick={() => { bringQuestionText(buildOneText(q, o), key, false) }}
                        >
                          {bringingKey === key ? props.t('question.bringing') : props.t('question.bringOne')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}

      <div className={`${css.panelList} ${panel.pastOpen ? css.panelListExpanded : ''}`} data-testid="sidechat-list">
        <div className={css.panelListActions}>
          <button
            type="button"
            className={css.panelListPast}
            data-testid="sidechat-past-toggle"
            aria-pressed={panel.pastOpen}
            onClick={() => { props.store.patch({ pastOpen: !panel.pastOpen }) }}
          >
            {panel.pastOpen ? props.t('past.hide') : props.t('past.show')}
          </button>
          {!panel.pastOpen && panel.items.length > 0 && (
            <button type="button" className={css.panelListDeleteAll} data-testid="sidechat-delete-all" onClick={disposeAll}>
              {props.t('panel.deleteAll')}
            </button>
          )}
        </div>
        {panel.pastOpen
          ? <PastSideChats parentSessionId={panel.parentSessionId} t={props.t} onOpen={openPast} />
          : panel.items.length === 0
          ? <div className={css.panelEmpty}>{props.t('panel.empty')}</div>
          : (
              <>
                {panel.items.map((item) => (
                  <SidechatListRow
                    key={item.childId}
                    item={item}
                    active={item.childId === panel.activeChildId}
                    t={props.t}
                    onSelect={() => { props.store.setActive(item.childId); void refreshHistory(props.store, item.childId) }}
                    onRename={(name) => { renameItem(item.childId, name) }}
                    onDispose={() => { disposeItem(item.childId) }}
                  />
                ))}
              </>
            )}
      </div>

      <div className={css.panelTranscript} ref={scrollRef} onScroll={onTranscriptScroll}>
        {panel.messages.map((message, index) => {
          const textBlocks = message.blocks.filter((b) => b.type === 'text')
          const imageBlocks = message.blocks.filter((b) => b.type === 'image')
          const reasoningBlocks = message.blocks.filter((b) => b.type === 'reasoning')
          const notices = message.blocks.filter((b): b is SidechatTurnNotice => b.type === 'turn-notice')
          const text = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
          const images = imageBlocks.map((b) => (b.type === 'image' ? { attachment: b.ref } : null)).filter((x): x is { attachment: SidechatImageRef } => x !== null)
          if (message.role === 'user') {
            return (
              <div key={index} className={css.messageUser}>
                {text !== '' && <span className={css.messageUserText}>{text}</span>}
                {images.length > 0 && (
                  <ImageGallery images={images.map((image) => image.attachment)} load={imageLoader} align="end" labels={messageImageLabels} />
                )}
              </div>
            )
          }
          return (
            <div key={index} className={css.messageAssistant} data-sidechat-role="assistant">
              {reasoningBlocks.map((block, rIndex) => (
                <ReasoningRow key={rIndex} text={block.type === 'reasoning' ? block.text : ''} t={props.t} />
              ))}
              {text !== '' && <MarkdownText text={escapeCurrency(text)} labels={markdownLabels} />}
              {text !== '' && (
                <div className={css.messageActions}>
                  <CopyReplyButton text={text} t={props.t} />
                  <button
                    type="button"
                    className={css.messageInsertButton}
                    onClick={() => {
                      void props.bringToMain(text).then((ok) => {
                        if (!ok) props.store.patch({ error: props.t('insert.failed') })
                      })
                    }}
                  >
                    {props.t('insert.direct')}
                  </button>
                  <button
                    type="button"
                    className={css.messageInsertButton}
                    disabled={summarizingIndex === index}
                    onClick={() => {
                      setSummarizingIndex(index)
                      void props.summarizeBring(text).then((ok) => {
                        setSummarizingIndex(null)
                        if (!ok) props.store.patch({ error: props.t('insert.summarizeFailed') })
                      })
                    }}
                  >
                    {summarizingIndex === index ? props.t('insert.summarizing') : props.t('insert.summarize')}
                  </button>
                </div>
              )}
              {notices.map((notice, nIndex) => (
                <TurnNoticeRow key={`notice-${nIndex}`} notice={notice} t={props.t} />
              ))}
            </div>
          )
        })}
        {visiblePending.map((echo) => (
          <div key={echo.id} className={css.messagePending} data-sidechat-pending={echo.mode}>
            <div className={css.messageUser}>
              {echo.text !== '' && <span className={css.messageUserText}>{echo.text}</span>}
              {echo.images > 0 && <span className={css.messagePendingImages}>{props.t('image.label')} × {echo.images}</span>}
            </div>
            <span className={css.messagePendingLabel}>
              {echo.mode === 'steer' ? props.t('panel.pending.steer') : echo.mode === 'queue' ? props.t('panel.pending.queue') : props.t('panel.pending.send')}
            </span>
          </div>
        ))}
        {activeRunning && (
          <div className={css.panelRunning} role="status" aria-live="polite">
            <span className={css.panelRunningDot} />
            <span>{props.t('panel.running')}</span>
            {showClock && <span className={css.panelRunningClock}>{props.formatDuration(elapsedMs)}</span>}
          </div>
        )}
        {panel.error !== null && <div className={css.panelError}>{props.t('panel.error')}: {panel.error}</div>}
      </div>

      {/* The side agent's own question: without this card the request reaches
          no surface at all and its turn blocks until the user aborts it. */}
      {sideQuestion !== null && sideQuestion.childId === panel.activeChildId && (
        <SideQuestionCard
          key={sideQuestion.key}
          request={sideQuestion}
          t={props.t}
          onSettled={() => { props.store.settleSideQuestion(sideQuestion.key) }}
          onError={(message) => { props.store.patch({ error: message }) }}
        />
      )}

      <div className={css.panelComposer}>
        {panel.attachment !== null && (
          <div className={css.panelAttachment} title={panel.attachment}>
            <span className={css.panelAttachmentText}><strong>{props.t('panel.quoteLabel')}:</strong> {panel.attachment}</span>
            <button type="button" className={css.panelAttachmentRemove} onClick={() => { props.store.patch({ attachment: null }) }}>×</button>
          </div>
        )}
        {panel.attachments.length > 0 && (
          <div className={css.panelAttachmentRail}>
            <AttachmentRail
              items={panel.attachments.map((a) => ({ id: a.id, previewUrl: a.previewUrl, alt: a.file.name || props.t('image.label'), removeLabel: props.t('image.remove') }))}
              labels={attachmentRailLabels}
              onOpen={(item) => { const a = panel.attachments.find((x) => x.id === item.id); if (a !== undefined) setLightbox(a) }}
              onRemove={(item) => { removeImage(item.id) }}
            />
          </div>
        )}
        <textarea
          data-sidechat-input=""
          className={css.panelTextarea}
          placeholder={activeRunning ? props.t('panel.input.placeholderRunning') : props.t('panel.input.placeholder')}
          value={panel.draft}
          onChange={(e) => { props.store.patch({ draft: e.target.value }) }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // While running: Enter steers into the current turn, Cmd/Ctrl+Enter queues for the next one.
              send(e.metaKey || e.ctrlKey ? 'queue' : 'steer')
            }
          }}
        />
        <div className={css.panelToolbar}>
          <ModelSelect
            directory={panel.directory}
            selection={{ provider: panel.provider, model: panel.model, effort: panel.effort }}
            onSelect={onModelSelect}
            t={props.t}
          />
          <PermissionSelect
            permissions={panel.permissions}
            preset={panel.preset}
            onSelect={onPresetChange}
            t={props.t}
          />
          {activeRunning && hasDraft && (
            <Tooltip label={props.t('panel.stop')} side="top" delayMs={500}>
              <button type="button" className={css.secondary} aria-label={props.t('panel.stop')} onClick={stop}>
                <IconStopFillRegular size={14} />
              </button>
            </Tooltip>
          )}
          <Tooltip
            label={!activeRunning ? props.t('panel.send') : hasDraft ? props.t('panel.steer') : props.t('panel.stop')}
            side="top"
            delayMs={500}
          >
            <button
              type="button"
              className={css.primary}
              aria-label={!activeRunning ? props.t('panel.send') : hasDraft ? props.t('panel.steer') : props.t('panel.stop')}
              onClick={(e) => {
                if (activeRunning && !hasDraft) stop()
                else send(e.metaKey || e.ctrlKey ? 'queue' : 'steer')
              }}
            >
              {activeRunning && !hasDraft ? <IconStopFillRegular size={16} /> : <IconSendOutlineRegular size={16} />}
            </button>
          </Tooltip>
        </div>

        <label className={css.panelLookup}>
          <input
            type="checkbox"
            checked={panel.lookup}
            onChange={(e) => { props.store.patch({ lookup: e.target.checked }) }}
          />
          <span>{props.t('panel.lookup')}</span>
        </label>
      </div>

      <div className={css.panelFooter}>
        <button type="button" className={css.panelDispose} onClick={dispose}>{props.t('panel.dispose')}</button>
      </div>

      {dragActive && <DropOverlay disabled={false} labels={dropOverlayLabels} />}
      {lightbox !== null && (
        <ImageLightbox
          src={lightbox.previewUrl}
          alt={lightbox.file.name || props.t('image.label')}
          labels={{ dialog: props.t('image.lightboxDialog'), close: props.t('image.close') }}
          onClose={() => { setLightbox(null) }}
        />
      )}
    </div>
  )
}

/** The "Side chat" settings section (two switches + a prompt textarea). */
/** Dock-mode body: the side-chat panel embedded in the built-in right sidebar's tab pane. */
function EmbeddedSidechatPanel(props: {
  store: SidechatStore
  t: (key: SidechatLocaleKey) => string
  formatDuration: (ms: number) => string
  bringToMain: (text: string) => Promise<boolean>
  summarizeBring: (text: string) => Promise<boolean>
  askSidechat: (text: string) => Promise<boolean>
  askSidechatNew: (text: string) => Promise<boolean>
}) {
  // The tab seat only mounts for the current session, so the shared store's
  // current-conversation state is the right one to draw.
  return (
    <SidechatPanel
      embedded
      store={props.store}
      t={props.t}
      formatDuration={props.formatDuration}
      bringToMain={props.bringToMain}
      summarizeBring={props.summarizeBring}
      askSidechat={props.askSidechat}
      askSidechatNew={props.askSidechatNew}
    />
  )
}

/** The portalled shell: floating menus + the panel, switching on prefs.panelHome. */
/**
 * The dock surface, guarded independently: it renders inside the host's
 * right-sidebar tab, so a drifted platform module must not take that sidebar
 * down with it.
 */
function DockPanel(props: Parameters<typeof EmbeddedSidechatPanel>[0]) {
  return (
    <SidechatErrorBoundary label="dock">
      <EmbeddedSidechatPanel {...props} />
    </SidechatErrorBoundary>
  )
}

function SideChatShell(props: {
  store: SidechatStore
  t: (key: SidechatLocaleKey) => string
  formatDuration: (ms: number) => string
  bringToMain: (text: string) => Promise<boolean>
  summarizeBring: (text: string) => Promise<boolean>
  askSidechat: (text: string) => Promise<boolean>
  askSidechatNew: (text: string) => Promise<boolean>
}) {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const [builtinOverlay, setBuiltinOverlay] = useState(false)

  // While the built-in right sidebar actually shows its panel (docked, fullscreen
  // or a floated pane), the floating side-chat panel would sit on top of it: yield
  // — slide the side chat away and drop its layout margin until the built-in panel
  // is closed again. Docked mode shares the sidebar instead, so it never needs
  // this guard.
  useEffect(() => {
    const probe = (): boolean => {
      if (document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]') !== null) return true
      const floatHost = document.querySelector('[data-sidebar-right-float-host]')
      if (floatHost !== null && floatHost.childElementCount > 0) return true
      return false
    }
    let active = probe()
    const apply = (): void => {
      const next = probe()
      if (next !== active) {
        active = next
        setBuiltinOverlay(next)
      }
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-panel', 'data-sidebar-right-float-host'],
    })
    window.addEventListener('resize', apply)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [])

  return (
    <>
      {!quoteSurfaceIntegrated && <SelectionMenu store={props.store} t={props.t} />}
      <BringBackMenu store={props.store} t={props.t} bringToMain={props.bringToMain} summarizeBring={props.summarizeBring} />
      {/* The pending-question entry floats in the portal, not inside the panel:
          in dock mode the panel (and its tab body) does not exist until the tab
          was opened at least once, but the entry must appear regardless. */}
      {snap.mainQuestion !== null && !snap.panel.open && (
        <QuestionFab
          store={props.store}
          t={props.t}
          onOpen={() => { props.store.openPanel(snap.panel.parentSessionId) }}
        />
      )}
      {(snap.prefs.panelHome === 'floating' || !snap.dockAvailable) && (
        <SidechatPanel
          store={props.store}
          t={props.t}
          formatDuration={props.formatDuration}
          bringToMain={props.bringToMain}
          summarizeBring={props.summarizeBring}
          askSidechat={props.askSidechat}
          askSidechatNew={props.askSidechatNew}
          conflictHidden={builtinOverlay}
        />
      )}
    </>
  )
}

function SettingsSection(props: { store: SidechatStore; t: (key: SidechatLocaleKey) => string }) {
  const { store, t } = props
  const { prefs } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [promptDraft, setPromptDraft] = useState(prefs.defaultPrompt)

  // Keep the local textarea in sync with the persisted value.
  useEffect(() => { setPromptDraft(prefs.defaultPrompt) }, [prefs.defaultPrompt])

  const toggle = useCallback((patch: Partial<SubchatPrefs>) => {
    const previous = prefs
    const next = { ...previous, ...patch }
    store.setPrefs(next)
    void api.settingsUpdate(patch).then((result) => {
      if (!result.ok) store.setPrefs(previous)
    })
  }, [prefs, store])

  const commitPrompt = useCallback(() => {
    const value = promptDraft.trim()
    if (value !== prefs.defaultPrompt) toggle({ defaultPrompt: value })
  }, [promptDraft, prefs.defaultPrompt, toggle])

  return (
    <div className={css.settingsSection}>
      <label className={css.settingsRow}>
        <span className={css.settingsRowText}>
          <span className={css.settingsRowTitle}>{t('settings.lookupTitle')}</span>
          <span className={css.settingsRowDesc}>{t('settings.lookupDesc')}</span>
        </span>
        <input
          type="checkbox"
          className={css.settingsToggle}
          checked={prefs.lookupDefault}
          aria-label={t('settings.lookupTitle')}
          onChange={(e) => { toggle({ lookupDefault: e.currentTarget.checked }) }}
        />
      </label>
      <label className={css.settingsRow}>
        <span className={css.settingsRowText}>
          <span className={css.settingsRowTitle}>{t('settings.sendImmediatelyTitle')}</span>
          <span className={css.settingsRowDesc}>{t('settings.sendImmediatelyDesc')}</span>
        </span>
        <input
          type="checkbox"
          className={css.settingsToggle}
          checked={prefs.sendImmediately}
          aria-label={t('settings.sendImmediatelyTitle')}
          onChange={(e) => { toggle({ sendImmediately: e.currentTarget.checked }) }}
        />
      </label>
      <div className={css.settingsRow}>
        <span className={css.settingsRowText}>
          <span className={css.settingsRowTitle}>{t('settings.bringModeTitle')}</span>
          <span className={css.settingsRowDesc}>{t('settings.bringModeDesc')}</span>
        </span>
      </div>
      <div className={css.settingsBringMode}>
        <label className={`${css.settingsBringOption} ${prefs.bringMode === 'draft' ? css.settingsBringOptionActive : ''}`}>
          <input
            type="radio"
            name="dsh-side-chat-bring-mode"
            className={css.settingsToggle}
            checked={prefs.bringMode === 'draft'}
            onChange={() => { toggle({ bringMode: 'draft' }) }}
          />
          <span className={css.settingsRowText}>
            <span className={css.settingsRowTitle}>{t('settings.bringModeDraftTitle')}</span>
            <span className={css.settingsRowDesc}>{t('settings.bringModeDraftDesc')}</span>
          </span>
        </label>
        <label className={`${css.settingsBringOption} ${prefs.bringMode === 'context' ? css.settingsBringOptionActive : ''}`}>
          <input
            type="radio"
            name="dsh-side-chat-bring-mode"
            className={css.settingsToggle}
            checked={prefs.bringMode === 'context'}
            onChange={() => { toggle({ bringMode: 'context' }) }}
          />
          <span className={css.settingsRowText}>
            <span className={css.settingsRowTitle}>{t('settings.bringModeContextTitle')}</span>
            <span className={css.settingsRowDesc}>{t('settings.bringModeContextDesc')}</span>
          </span>
        </label>
      </div>
      <div className={css.settingsRow}>
        <span className={css.settingsRowText}>
          <span className={css.settingsRowTitle}>{t('settings.panelHomeTitle')}</span>
          <span className={css.settingsRowDesc}>{t('settings.panelHomeDesc')}</span>
        </span>
      </div>
      <div className={css.settingsBringMode}>
        <label className={`${css.settingsBringOption} ${prefs.panelHome === 'floating' ? css.settingsBringOptionActive : ''}`}>
          <input
            type="radio"
            name="dsh-side-chat-panel-home"
            className={css.settingsToggle}
            checked={prefs.panelHome === 'floating'}
            onChange={() => { toggle({ panelHome: 'floating' }) }}
          />
          <span className={css.settingsRowText}>
            <span className={css.settingsRowTitle}>{t('settings.panelHomeFloatingTitle')}</span>
            <span className={css.settingsRowDesc}>{t('settings.panelHomeFloatingDesc')}</span>
          </span>
        </label>
        <label className={`${css.settingsBringOption} ${prefs.panelHome === 'sidebar-right' ? css.settingsBringOptionActive : ''}`}>
          <input
            type="radio"
            name="dsh-side-chat-panel-home"
            className={css.settingsToggle}
            checked={prefs.panelHome === 'sidebar-right'}
            onChange={() => { toggle({ panelHome: 'sidebar-right' }) }}
          />
          <span className={css.settingsRowText}>
            <span className={css.settingsRowTitle}>{t('settings.panelHomeDockTitle')}</span>
            <span className={css.settingsRowDesc}>{t('settings.panelHomeDockDesc')}</span>
          </span>
        </label>
      </div>
      <div className={css.settingsRow}>
        <span className={css.settingsRowText}>
          <span className={css.settingsRowTitle}>{t('settings.defaultPromptTitle')}</span>
          <span className={css.settingsRowDesc}>{t('settings.defaultPromptDesc')}</span>
        </span>
      </div>
      <textarea
        className={css.settingsPromptInput}
        value={promptDraft}
        placeholder={t('settings.defaultPromptPlaceholder')}
        aria-label={t('settings.defaultPromptTitle')}
        onChange={(e) => { setPromptDraft(e.currentTarget.value) }}
        onBlur={commitPrompt}
      />
    </div>
  )
}

/** Client plugin body. */
export function apply(ctx: Context): void {
  const store = createStore()

  // Localized copy follows the DSH locale (module-level mirror for callbacks).
  let activeLocale = ctx.locale.getSnapshot().active

  /**
   * The selected main-view Session. DSH 0.1.6-alpha.2 reworked Client Sessions
   * into independent instances and moved the selection off the list snapshot
   * (`sessions.list.current`, dropped) onto the ui-session scope binding;
   * older lines keep it on the list. Read the binding first, then fall back.
   */
  const currentSessionId = (): string | undefined =>
    ctx.uiSession.adapter?.current.getSnapshot().key ?? ctx.sessions.list.getSnapshot().current

  /** Subscribe to current-Session changes on whichever face this DSH exposes. */
  const subscribeCurrentSession = (fn: () => void): (() => void) => {
    const offList = ctx.sessions.list.subscribe(fn)
    const offAdapter = ctx.uiSession.adapter?.current.subscribe(fn)
    if (offAdapter === undefined) return offList
    return () => { offList(); offAdapter() }
  }

  /**
   * The pending interaction for one Session — DSH 0.1.6-alpha.2 moved it from
   * `uiSession.pendingInteractions` onto `uiSession.sessionStatus`; read
   * whichever face this build exposes.
   */
  const pendingInteractionFor = (sessionId: string): SidePendingInteraction | undefined => {
    if (ctx.uiSession.sessionStatus !== undefined) {
      return ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction
    }
    return ctx.uiSession.pendingInteractions?.getSnapshot().get(sessionId)
  }

  /** Subscribe to pending-interaction changes on whichever face this DSH exposes. */
  const subscribePendingInteractions = (fn: () => void): (() => void) => {
    if (ctx.uiSession.sessionStatus !== undefined) return ctx.uiSession.sessionStatus.subscribe(fn)
    if (ctx.uiSession.pendingInteractions !== undefined) return ctx.uiSession.pendingInteractions.subscribe(fn)
    return () => {}
  }

  /** Append text to the main composer draft (draft bring mode). */
  const draftBring = (text: string): boolean => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const sessionId = currentSessionId()
    if (sessionId === undefined) return false
    try {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) return false
      const input = ctx.conversation.input.for(actx)
      const draft = input.state.getSnapshot().draft
      input.setDraft(draft === '' ? trimmed : `${draft}\n\n${trimmed}`)
      return true
    } catch {
      return false
    }
  }

  /** Inject text into the main conversation as a collapsed, source-tagged context row. */
  const injectBring = async (text: string, summary: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const sessionId = currentSessionId()
    if (sessionId === undefined) return false
    const result = await api.inject({ parentSessionId: sessionId, text: trimmed, summary })
    return result.ok
  }

  /** Land text in the main conversation per the configured bring mode. */
  const landText = async (text: string, summaryKey: SidechatLocaleKey): Promise<boolean> => {
    const mode = store.getSnapshot().prefs.bringMode
    if (mode === 'context') {
      return injectBring(text, translate(activeLocale, summaryKey))
    }
    return draftBring(text)
  }

  /** Bring a reply back directly (routed through the configured mode). */
  const bringToMain = (text: string): Promise<boolean> => landText(text, 'insert.contextSummary')

  /** Summarize text with the side chat's inherited model, then bring the summary back. */
  const summarizeBring = async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const snap = store.getSnapshot().panel
    if (snap.parentSessionId === '') return false
    const result = await api.summarize({
      parentSessionId: snap.parentSessionId,
      text: trimmed,
      ...(snap.provider !== '' ? { provider: snap.provider } : {}),
      ...(snap.model !== '' ? { model: snap.model } : {}),
      ...(snap.effort !== '' ? { reasoningEffort: snap.effort } : {}),
      locale: activeLocale,
    })
    if (!result.ok) return false
    return landText(result.value.summary, 'insert.summarizeContextSummary')
  }

  /** Ask a piece of text in the side chat (start a new one, or continue the active one). */
  const askSidechat = async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const parentSessionId = currentSessionId()
    if (parentSessionId === undefined) return false
    const panel = store.getSnapshot().panel
    const content: PromptContentPart[] = [{ type: 'text', text: trimmed }]

    // Reuse the active side chat, else the first existing one, else create one —
    // so bringing dialog questions in doesn't pile up a new side chat per ask.
    const target = panel.activeChildId ?? panel.items[0]?.childId ?? null

    if (target === null) {
      const result = await api.start({
        parentSessionId,
        content,
        lookupEnabled: panel.lookup,
        ...(panel.provider !== '' ? { provider: panel.provider } : {}),
        ...(panel.model !== '' ? { model: panel.model } : {}),
        ...(panel.effort !== '' ? { reasoningEffort: panel.effort } : {}),
      })
      if (result.ok) {
        store.openPanel(parentSessionId)
        store.setActive(result.value.childId)
        store.patch({ provider: result.value.provider, model: result.value.model, effort: result.value.reasoningEffort ?? '' })
        void refreshList(store, parentSessionId)
        void refreshDirectory(store)
        return true
      }
      return false
    }

    const childId = target
    if (childId !== panel.activeChildId) store.setActive(childId)
    setItemRunning(store, childId, true)
    const result = await api.followup({ childId, content, lookupEnabled: panel.lookup })
    if (!result.ok) {
      setItemRunning(store, childId, false)
      store.patch({ error: result.error.message })
    }
    void refreshList(store, parentSessionId)
    void refreshHistory(store, childId)
    return result.ok
  }

  /** Ask a piece of text in a brand-new side chat (never reuses an existing one). */
  const askSidechatNew = async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const parentSessionId = currentSessionId()
    if (parentSessionId === undefined) return false
    const panel = store.getSnapshot().panel
    const content: PromptContentPart[] = [{ type: 'text', text: trimmed }]
    const result = await api.start({
      parentSessionId,
      content,
      lookupEnabled: panel.lookup,
      ...(panel.provider !== '' ? { provider: panel.provider } : {}),
      ...(panel.model !== '' ? { model: panel.model } : {}),
      ...(panel.effort !== '' ? { reasoningEffort: panel.effort } : {}),
    })
    if (result.ok) {
      store.openPanel(parentSessionId)
      store.setActive(result.value.childId)
      store.patch({ provider: result.value.provider, model: result.value.model, effort: result.value.reasoningEffort ?? '' })
      void refreshList(store, parentSessionId)
      void refreshDirectory(store)
      return true
    }
    return false
  }

  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    const offSub = ctx.locale.subscribe(() => {
      activeLocale = ctx.locale.getSnapshot().active
      store.patch({})
    })
    return () => { offZh(); offEn(); offSub() }
  }, 'dsh-side-chat: dictionaries')

  // "Side chat" row in the composer's + menu (and `/sidechat`): opens this
  // conversation's side-chat panel. Optional — older DSH lines without the
  // client command surface simply show no row.
  ctx.inject(['commandUi'], (scope: Context) => {
    const commandUi = (scope as unknown as { commandUi: SideCommandUi }).commandUi
    scope.effect(() => commandUi.register({
      name: 'sidechat',
      label: () => translate(activeLocale, 'menu.label'),
      description: () => translate(activeLocale, 'menu.description'),
      icon: SidechatMenuIcon,
      available: (session) => typeof session.sessionId === 'string' && session.sessionId !== '',
      ui: {
        kind: 'action',
        run: (session) => {
          const sessionId = session.sessionId
          store.openPanel(sessionId)
          void refreshList(store, sessionId).then(() => {
            const panel = store.getSnapshot().panel
            if (panel.parentSessionId !== sessionId || panel.activeChildId !== null) return
            // Nothing selected yet: show the newest side chat, or the past list
            // when this conversation has none listed (e.g. all were closed).
            const newest = panel.items[panel.items.length - 1]
            if (newest !== undefined) {
              store.setActive(newest.childId)
              void refreshHistory(store, newest.childId)
            } else {
              store.patch({ pastOpen: true })
            }
          })
        },
      },
    }), 'dsh-side-chat: + menu entry')
  })

  // Selection popup + right-click menu on chat text, through DSH's own
  // text-interaction surface (so the built-in "Quote text" stays available).
  const uiConversation = ctx.get('uiConversation') as {
    interactions?: {
      register(definition: {
        id: string
        onInteraction(request: {
          trigger: string
          readText(): string | null
          open(): void
          preventDefault(): void
        }): void
      }): () => void
    }
  } | undefined
  if (uiConversation?.interactions !== undefined) {
    quoteSurfaceIntegrated = true
    const quoteT = (key: SidechatLocaleKey): string => translate(activeLocale, key)
    const quoteInject = () => ({ store, sideT: quoteT, currentSessionId })
    // Shadow the built-in Quote action (lowest priority renders) with the
    // combined Quote / Quote-in-side-chat surface.
    ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
      name: 'conversation.chat.text-interaction',
      key: 'quote',
      priority: -10,
      inject: quoteInject,
    }, QuoteActions as never))
    // Right-click on selected chat text: same actions as a small menu.
    ctx.effect(() => uiConversation.interactions!.register({
      id: CONTEXT_INTERACTION_ID,
      onInteraction(request) {
        if (request.trigger !== 'contextmenu') return
        const text = request.readText()
        if (text === null || text.trim() === '') return
        request.preventDefault()
        request.open()
      },
    }), 'dsh-side-chat: right-click quote interaction')
    ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
      name: 'conversation.chat.text-interaction',
      key: CONTEXT_INTERACTION_ID,
      inject: quoteInject,
    }, QuoteActions as never))
  }

  // Load the persisted preferences once.
  void api.settingsGet().then((result) => {
    if (!result.ok) return
    const raw = result.value.value as Partial<SubchatPrefs> | null | undefined
    if (raw === null || raw === undefined) return
    store.setPrefs({
      lookupDefault: typeof raw.lookupDefault === 'boolean' ? raw.lookupDefault : SUBCHAT_PREFS_DEFAULTS.lookupDefault,
      sendImmediately: typeof raw.sendImmediately === 'boolean' ? raw.sendImmediately : SUBCHAT_PREFS_DEFAULTS.sendImmediately,
      defaultPrompt: typeof raw.defaultPrompt === 'string' ? raw.defaultPrompt : SUBCHAT_PREFS_DEFAULTS.defaultPrompt,
      bringMode: raw.bringMode === 'context' ? 'context' : 'draft',
      panelHome: raw.panelHome === 'floating' ? 'floating' : 'sidebar-right',
    })
  })

  // Track the current conversation (per-conversation panel state).
  ctx.effect(() => {
    let lastId: string | undefined
    const sync = (): void => {
      const next = currentSessionId()
      if (next === lastId) return
      lastId = next
      // The panel of the conversation being left: when its side chats moved to
      // the next one (a message edit/rewind replaces the conversation with a
      // new session), the panel follows them instead of resetting.
      const previous = store.getSnapshot().panel
      store.setCurrent(next)
      if (next === undefined) return
      void refreshList(store, next).then(() => {
        const now = store.getSnapshot()
        if (now.current !== next || now.panel.activeChildId !== null) return
        const carried = previous.activeChildId
        if (carried === null || !now.panel.items.some((i) => i.childId === carried)) return
        store.setActive(carried)
        store.patch({ lookup: previous.lookup, provider: previous.provider, model: previous.model, effort: previous.effort, preset: previous.preset, draft: previous.draft })
        if (previous.open) store.openPanel(next)
        void refreshHistory(store, carried)
      })
      const panel = store.getSnapshot().panel
      if (panel.open && panel.activeChildId !== null) {
        void refreshHistory(store, panel.activeChildId)
      }
    }
    sync()
    return subscribeCurrentSession(sync)
  }, 'dsh-side-chat: follow current conversation')

  // Track the main conversation's pending user-question dialog so the panel can
  // list its questions/options with per-item bring-back buttons. DSH surfaces
  // the pending interaction per Session: `uiSession.pendingInteractions`
  // through 0.1.6-alpha.1, and `uiSession.sessionStatus` (`.pendingInteraction`)
  // from 0.1.6-alpha.2 — `pendingInteractionFor` reads whichever is present.
  // Only re-publishes when the question object identity changes.
  ctx.effect(() => {
    let lastQuestion: unknown = undefined
    const read = (): void => {
      const sessionId = currentSessionId()
      if (sessionId === undefined) {
        store.setMainQuestion(null)
        return
      }
      const interaction = pendingInteractionFor(sessionId)
      const isQuestion = interaction !== undefined && (interaction.kind === 'question' || interaction.kind === 'plan-review')
      const question = isQuestion ? interaction : undefined
      if (question === lastQuestion) return
      lastQuestion = question
      const questions = question?.questions ?? null
      store.setMainQuestion(questions === null ? null : [...questions])
    }
    read()
    const offPending = subscribePendingInteractions(read)
    const offList = subscribeCurrentSession(read)
    return () => { offPending(); offList() }
  }, 'dsh-side-chat: track main question dialog')

  // Safety net: once the main conversation no longer has a pending question
  // dialog, clear the tracked question so the side-panel list disappears too
  // (covers cases where the subscription misses the settlement edge).
  ctx.effect(() => {
    const timer = window.setInterval(() => {
      if (store.getSnapshot().mainQuestion === null) return
      const sessionId = currentSessionId()
      if (sessionId === undefined) return
      const interaction = pendingInteractionFor(sessionId)
      const hasQuestion = interaction !== undefined && (interaction.kind === 'question' || interaction.kind === 'plan-review')
      if (!hasQuestion) store.setMainQuestion(null)
    }, 1200)
    return () => { window.clearInterval(timer) }
  }, 'dsh-side-chat: clear stale question dialog')

  // Track the ACTIVE SIDE CHAT's own pending `ask_user_question`.
  //
  // The host publishes a question card per Session, but renders it into the
  // `conversation.composer` slot — which exists only for the main conversation
  // view. A side chat has its own composer in this panel, so its agent's
  // question reached no surface at all and the turn blocked until the user
  // aborted it (`ASK_ABORTED`). Reading the child Session's pending
  // interaction here gives the panel the same carrier the main card would
  // have used, so the panel can render and answer it.
  //
  // The child Session is only listed while its turn runs (the plugin archives
  // it when idle), which is exactly the window a pending question lives in.
  ctx.effect(() => {
    let lastKey: string | undefined
    let offCarrier: (() => void) | undefined
    // `read` is a store subscriber AND writes to the store. `setSideQuestion`
    // only notifies on a real change, so the loop terminates on its own; this
    // guard keeps the re-entrant pass from doing the work twice.
    let reading = false
    const read = (): void => {
      if (reading) return
      reading = true
      try { readOnce() } finally { reading = false }
    }
    const readOnce = (): void => {
      const childId = store.getSnapshot().panel.activeChildId
      if (childId === null) {
        if (lastKey !== undefined) { lastKey = undefined; offCarrier?.(); offCarrier = undefined }
        store.setSideQuestion(null)
        return
      }
      const interaction = pendingInteractionFor(childId)
      // Only the answerable question family; an approval carries no question list.
      const isQuestion = interaction !== undefined
        && (interaction.kind === 'question' || interaction.kind === 'plan-review')
        && Array.isArray(interaction.questions) && interaction.questions.length > 0
        && typeof interaction.answer === 'function'
      if (!isQuestion) {
        if (lastKey !== undefined) { lastKey = undefined; offCarrier?.(); offCarrier = undefined }
        store.setSideQuestion(null)
        return
      }
      if (interaction.key === lastKey) return
      lastKey = interaction.key
      // Follow the carrier so a question that is CLOSED elsewhere (removed from
      // the registry after being answered in another browser, or aborted)
      // clears this panel too.
      //
      // Only `closed` ends the card. `channel` must NOT: submitting resolves
      // the waterfall, which synchronously detaches it and reports
      // `channel: 'none'` — reading that as a teardown unmounted the card from
      // inside its own submit handler, dropped the answer, and then
      // re-published the same question in a loop (the UI froze).
      offCarrier?.()
      offCarrier = interaction.subscribe?.(() => {
        if (interaction.getSnapshot?.()?.closed !== true) return
        lastKey = undefined
        offCarrier?.()
        offCarrier = undefined
        store.setSideQuestion(null)
      })
      store.setSideQuestion({
        childId,
        key: interaction.key,
        questions: [...interaction.questions!],
        answer: (batch) => interaction.answer!(batch),
      })
    }
    read()
    const offPending = subscribePendingInteractions(read)
    const offStore = store.subscribe(read)
    return () => { offPending(); offStore(); offCarrier?.() }
  }, 'dsh-side-chat: track side chat question')

  // Optional dock mode: live inside the new built-in right sidebar
  // (dsh-client-ui-sidebar-right) as a "Side chat" tab instead of the floating
  // panel. Registered on demand; falls back to floating when the service is
  // absent (older deployments) without ever failing to mount.
  ctx.effect(() => {
    let cleanup: (() => void) | undefined
    // Explicit phase machine: sync() runs on every store notify, and patching
    // the store from inside sync() must never re-enter registration work.
    let phase: 'idle' | 'docked' | 'unavailable' = 'idle'

    const sync = (): void => {
      const docked = store.getSnapshot().prefs.panelHome === 'sidebar-right'
      if (docked) {
        if (phase === 'docked' || phase === 'unavailable') return
        const sidebarRight = ctx.get('sidebarRight') as SideSidebarRight | undefined
        // Use the public registry shared by official Sidebar conversations.
        const sidebarRightTabs = (ctx.get('sidebarRightTabs') as SideSidebarRightTabs | undefined)
          ?? sidebarRight?.tabs
        if (sidebarRight === undefined || sidebarRightTabs === undefined) {
          phase = 'unavailable'
          // The floating container takes over (SideChatShell renders it while
          // `dockAvailable` is false); the notice only explains why the dock
          // preference is not in effect.
          store.setDockAvailable(false)
          store.patch({ error: translate(activeLocale, 'dock.unavailable') })
          return
        }
        store.setDockAvailable(true)
        const dockT = (key: SidechatLocaleKey): string => translate(activeLocale, key)

        const disposeType = sidebarRightTabs.register({
          id: SIDEBAR_TAB_ID,
          kind: SIDEBAR_TAB_KIND,
          priority: 'extension',
          title: () => dockT('dock.title'),
        })
        // Body seat: rendered for the committed tab whose type id matches `key`.
        const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: SIDEBAR_TAB_ID,
          inject: () => ({
            store,
            t: dockT,
            formatDuration,
            bringToMain,
            summarizeBring,
            askSidechat,
            askSidechatNew,
          }),
        }, DockPanel))
        const launch = (): void => {
          try {
            sidebarRight.openTab(SIDEBAR_TAB_KIND, { revealIfOpened: true })
          } catch (error) {
            store.patch({ error: `${translate(activeLocale, 'dock.openFailed')}: ${error instanceof Error ? error.message : String(error)}` })
          }
        }
        store.setDockLaunch(launch)
        cleanup = () => {
          store.setDockLaunch(null)
          disposeBody()
          disposeType()
        }
        phase = 'docked'
        return
      }
      if (phase === 'idle') return
      phase = 'idle'
      store.setDockLaunch(null)
      cleanup?.()
      cleanup = undefined
    }

    sync()
    const off = store.subscribe(sync)
    return () => {
      off()
      cleanup?.()
    }
  }, 'dsh-side-chat: right-sidebar dock')

  // The "Side chat" settings section.
  const settingsT = (key: SidechatLocaleKey): string => translate(activeLocale, key)
  const formatDuration = (ms: number): string => formatRunDuration(ms, activeLocale)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-side-chat',
    order: 110,
    label: () => settingsT('settingsNav'),
    inject: () => ({ store, t: settingsT }),
  }, SettingsSection))

  // Mount the portalled tree onto document.body.
  ctx.effect(() => {
    // DSH 0.2.1-rc.1 reloads a replaceable plugin in place, so this factory can
    // run again in the same document; drop any host a previous mount left
    // behind before mounting, or the panel would be rendered twice.
    for (const stale of document.querySelectorAll('[data-dsh-side-chat]')) stale.remove()
    const host = document.createElement('div')
    host.setAttribute('data-dsh-side-chat', '')
    document.body.appendChild(host)
    const root = createRoot(host)

    const t = (key: SidechatLocaleKey): string => translate(activeLocale, key)
    root.render(
      <SidechatErrorBoundary label="panel">
        <SideChatShell
          store={store}
          t={t}
          formatDuration={formatDuration}
          bringToMain={bringToMain}
          summarizeBring={summarizeBring}
          askSidechat={askSidechat}
          askSidechatNew={askSidechatNew}
        />
      </SidechatErrorBoundary>,
    )

    return () => {
      root.unmount()
      host.remove()
    }
  }, 'dsh-side-chat: panel mount')
}
