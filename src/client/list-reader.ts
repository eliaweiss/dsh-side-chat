import type { SidechatListItem, SidechatPastItem, SidechatResult } from './api.ts'

/** While the full archive is loading, the live list already has genuine rows
 * for this parent (but not dates/previews). Never infer that the archive is
 * empty just because the live list is empty. */
export function provisionalPastRows(live: SidechatListItem[], cached: SidechatPastItem[] | null): SidechatPastItem[] {
  const byId = new Map((cached ?? []).map((row) => [row.childId, row]))
  for (const { childId, name, preview } of live) {
    const old = byId.get(childId)
    byId.set(childId, { childId, name, preview: preview || old?.preview || '', createdAt: old?.createdAt ?? 0, status: 'listed' })
  }
  return [...byId.values()]
}

/** One activation's current-parent list read. Polls and panel opens can join
 * the preload, but a mutation needs a read started after the mutation. */
export function createListReader(
  load: (parent: string) => Promise<SidechatResult<{ items: SidechatListItem[] }>>,
  publish: (items: SidechatListItem[]) => void,
  fail: (message: string) => void,
) {
  let parent: string | undefined
  let pending: Promise<boolean> | undefined
  return {
    setParent(next: string | undefined) {
      parent = next
      pending = undefined
    },
    refresh(id: string, afterMutation = false): Promise<boolean> {
      if (parent !== id) return Promise.resolve(false)
      if (pending && !afterMutation) return pending
      const request: Promise<boolean> = load(id).then((result) => {
        if (request !== pending) return false
        if (!result.ok) { fail(result.error.message); return false }
        publish(result.value.items)
        return true
      }).catch((error: unknown) => {
        if (request === pending) fail(error instanceof Error ? error.message : String(error))
        return false
      }).finally(() => {
        if (request === pending) pending = undefined
      })
      pending = request
      return request
    },
  }
}
