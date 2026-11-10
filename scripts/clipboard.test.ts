/** Copy on a side-chat reply writes its exact Markdown, with a fallback when the async clipboard fails. */
import { expect, test } from 'vitest'
import { copyText } from '../src/client/clipboard.ts'

const reply = 'Use **`pnpm build`**, then:\n\n- reload\n- costs $5'

test('writes the exact text through the async clipboard', async () => {
  const written: string[] = []
  const ok = await copyText(reply, {
    clipboard: { writeText: async (text) => { written.push(text) } },
    legacyCopy: () => { throw new Error('should not be used') },
  })
  expect(ok).toBe(true)
  expect(written).toEqual([reply])
})

test('falls back when the async clipboard is refused', async () => {
  const legacy: string[] = []
  const ok = await copyText(reply, {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError') } },
    legacyCopy: (text) => { legacy.push(text); return true },
  })
  expect(ok).toBe(true)
  expect(legacy).toEqual([reply])
})

test('falls back when there is no async clipboard', async () => {
  expect(await copyText(reply, { legacyCopy: () => true })).toBe(true)
})

test('reports failure when nothing can copy', async () => {
  expect(await copyText(reply, { legacyCopy: () => false })).toBe(false)
  expect(await copyText(reply, {})).toBe(false)
})
