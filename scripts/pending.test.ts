import { expect, test } from 'vitest'
import { unresolvedEchoes, userMessageCount, type PendingEcho } from '../src/client/pending.ts'
import type { SidechatMessage } from '../src/client/api.ts'

const user = (text: string): SidechatMessage => ({ role: 'user', blocks: [{ type: 'text', text }] })
const reply = (text: string): SidechatMessage => ({ role: 'assistant', blocks: [{ type: 'text', text }] })
const echo = (id: string, text: string, baseline: number, mode: PendingEcho['mode'] = 'queue'): PendingEcho =>
  ({ id, text, images: 0, mode, baseline, sentAt: 0 })

test('an echo stays until the transcript records its message', () => {
  const history = [user('first'), reply('working')]
  const pending = [echo('a', 'second', userMessageCount(history))]
  expect(unresolvedEchoes(pending, history).map((p) => p.id)).toEqual(['a'])
  expect(unresolvedEchoes(pending, [...history, user('second')])).toEqual([])
})

test('a steered message can land before an earlier queued one', () => {
  const history = [user('first')]
  const pending = [echo('q', 'queued one', 1, 'queue'), echo('s', 'steer one', 1, 'steer')]
  const left = unresolvedEchoes(pending, [...history, reply('…'), user('steer one')])
  expect(left.map((p) => p.id)).toEqual(['q'])
})

test('an older identical message does not resolve a new echo', () => {
  const history = [user('ok'), reply('done')]
  expect(unresolvedEchoes([echo('a', 'ok', 1)], history).map((p) => p.id)).toEqual(['a'])
})
