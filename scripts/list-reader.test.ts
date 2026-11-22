import { expect, test, vi } from 'vitest'
import { createListReader, provisionalPastRows } from '../src/client/list-reader.ts'
import type { SidechatListItem, SidechatResult } from '../src/client/api.ts'

const success = (childId: string): SidechatResult<{ items: SidechatListItem[] }> => ({ ok: true, value: { items: [{ childId, running: false }] } })

test('on a cold archive open, already listed chats appear without fabricated preview or date', () => {
  expect(provisionalPastRows([{ childId: 'a1', name: 'Known', running: true }], null)).toEqual([
    { childId: 'a1', name: 'Known', status: 'listed', preview: '', createdAt: 0 },
  ])
})

test('a warm archive keeps known metadata without duplicating or reverting a newly renamed/restored row', () => {
  const closed = { childId: 'c', status: 'closed', preview: 'kept', createdAt: 20 } as const
  const reopened = { childId: 'r', status: 'closed', name: 'before', preview: 'also kept', createdAt: 10 } as const
  expect(provisionalPastRows([{ childId: 'r', name: 'after', running: false }], [closed, reopened])).toEqual([
    closed, { ...reopened, name: 'after', status: 'listed' },
  ])
})

function setup() {
  const responses: Array<(result: SidechatResult<{ items: SidechatListItem[] }>) => void> = []
  const load = vi.fn(() => new Promise<SidechatResult<{ items: SidechatListItem[] }>>((resolve) => responses.push(resolve)))
  const publish = vi.fn(), fail = vi.fn()
  const lists = createListReader(load, publish, fail)
  lists.setParent('a')
  return { lists, load, publish, fail, responses }
}

test('opening the panel shares its active session preload and recognizes an empty result', async () => {
  const { lists, load, publish, responses } = setup()
  const preload = lists.refresh('a')
  expect(lists.refresh('a')).toBe(preload)
  responses[0]!({ ok: true, value: { items: [] } })
  expect(await preload).toBe(true)
  expect(load).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith([])
})

test('a mutation revalidates even while a preload is pending, and ignores its older result', async () => {
  const { lists, publish, responses } = setup()
  const stale = lists.refresh('a'), renamed = lists.refresh('a', true)
  expect(lists.refresh('a')).toBe(renamed)
  responses[1]!(success('new'))
  responses[0]!(success('old'))
  expect(await renamed).toBe(true)
  expect(await stale).toBe(false)
  expect(publish.mock.calls).toEqual([[[{ childId: 'new', running: false }]]])
})

test('late results cannot populate the next conversation or a later visit to the same one', async () => {
  const { lists, publish, fail, responses } = setup()
  const old = lists.refresh('a')
  lists.setParent('b')
  expect(await lists.refresh('a', true)).toBe(false)
  const other = lists.refresh('b')
  lists.setParent('a')
  const current = lists.refresh('a')
  responses[0]!(success('other-visit'))
  responses[1]!({ ok: false, error: { code: 'error', message: 'wrong session' } })
  expect(await Promise.all([old, other])).toEqual([false, false])
  expect(publish).not.toHaveBeenCalled()
  expect(fail).not.toHaveBeenCalled()
  responses[2]!(success('current'))
  expect(await current).toBe(true)
})

test('a failed list does not masquerade as an empty list and can be retried', async () => {
  const { lists, publish, fail, responses } = setup()
  const failed = lists.refresh('a')
  responses[0]!({ ok: false, error: { code: 'error', message: 'unavailable' } })
  expect(await failed).toBe(false)
  expect(fail).toHaveBeenCalledWith('unavailable')
  expect(publish).not.toHaveBeenCalled()
  const retry = lists.refresh('a')
  responses[1]!(success('restored'))
  expect(await retry).toBe(true)
})
