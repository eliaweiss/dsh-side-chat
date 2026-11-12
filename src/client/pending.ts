/**
 * Local echoes of side-chat messages the host transcript has not recorded yet,
 * so a message sent while the side chat runs stays visible (as in the main
 * chat) until the agent claims it.
 */
import type { SidechatMessage } from './api.ts'

/** How one message was delivered: idle send, queued next turn, or steered into the running turn. */
export type PendingMode = 'send' | 'queue' | 'steer'

/** One sent message still waiting to appear in the transcript. */
export interface PendingEcho {
  id: string
  /** The exact text sent (quote + draft), '' for an image-only message. */
  text: string
  /** Number of images sent with it. */
  images: number
  mode: PendingMode
  /** User-message count of the transcript when it was sent; only later user messages can match it. */
  baseline: number
  sentAt: number
}

/** Pixels from the bottom that still count as "at the bottom" for scroll following. */
export const FOLLOW_THRESHOLD_PX = 40

/** How long an echo may sit unmatched while the side chat is idle before it is dropped. */
export const STALE_ECHO_MS = 4000

/** Number of user messages in a transcript. */
export function userMessageCount(messages: readonly SidechatMessage[]): number {
  let count = 0
  for (const m of messages) if (m.role === 'user') count += 1
  return count
}

/** The text and image count of one user message, as an echo would carry them. */
function userKey(message: SidechatMessage): string {
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).filter((t) => t !== '').join('\n').trim()
  const images = message.blocks.filter((b) => b.type === 'image').length
  return `${images}|${text}`
}

/**
 * Drop every echo the transcript now records. Each recorded user message
 * matches at most one echo, and only echoes sent before it arrived (steered
 * messages can land before earlier queued ones, so order is not assumed).
 */
export function unresolvedEchoes(pending: readonly PendingEcho[], messages: readonly SidechatMessage[]): PendingEcho[] {
  if (pending.length === 0) return []
  const users = messages.filter((m) => m.role === 'user').map(userKey)
  const consumed = new Set<number>()
  const left: PendingEcho[] = []
  for (const echo of pending) {
    const key = `${echo.images}|${echo.text.trim()}`
    let match = -1
    for (let i = echo.baseline; i < users.length; i += 1) {
      if (!consumed.has(i) && users[i] === key) { match = i; break }
    }
    if (match === -1) left.push(echo)
    else consumed.add(match)
  }
  return left.length === pending.length ? [...pending] : left
}
