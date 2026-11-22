import type { SidechatMessage } from './api.ts'

type TitleFields = { name?: string; preview?: string }

/** The same label in the archive, the live list and the opened conversation. */
export function chatTitle(row: TitleFields | undefined, untitled: string, messages?: SidechatMessage[]): string {
  const known = row?.name?.trim() || row?.preview?.trim()
  if (known) return known
  // Legacy chats may not have an indexed preview yet. Use history only if
  // it's already on screen; displaying a title must never request a log.
  const prompt = messages?.find(message => message.role === 'user')
  return prompt?.blocks.map(block => block.type === 'text' ? block.text : '').join(' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160) || untitled
}
