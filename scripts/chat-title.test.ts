import { expect, test } from 'vitest'
import { chatTitle } from '../src/client/chat-title.ts'
import { provisionalPastRows } from '../src/client/list-reader.ts'

const fallback = 'Untitled side chat'
const archive = { childId: 'subchat-private-id', preview: 'Why did the build fail?', status: 'closed', createdAt: 1 } as const

test('a restored chat keeps its archive label when it becomes a live row', () => {
  const live = { childId: archive.childId, preview: archive.preview, running: false }
  const provisional = provisionalPastRows([live], null)[0]
  for (const row of [archive, live, provisional]) expect(chatTitle(row, fallback)).toBe(archive.preview)
  expect(chatTitle({ ...live, name: 'Build investigation' }, fallback)).toBe('Build investigation')
  expect(chatTitle({ ...live, name: ' ' }, fallback)).toBe(archive.preview)
})

test('an older chat uses already loaded prompt text, never the session ID', () => {
  const legacy = { childId: archive.childId, preview: '' }
  expect(chatTitle(legacy, fallback, [
    { role: 'assistant', blocks: [{ type: 'text', text: 'not a title' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'A\n question' }] },
  ])).toBe('A question')
  expect(chatTitle(legacy, fallback, [])).toBe(fallback)
})
