import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Immutable session facts only. Current ownership and names stay in the existing records. */
export interface PastRecord {
  childId: string
  parentSessionId: string
  createdAt: number
  /** Absent on imported headers until this parent's history is requested. */
  preview?: string
}

export const SIDECHAT_ID = /^subchat-[0-9a-zA-Z]+(?:-[0-9a-zA-Z]+)*$/

function isRecord(value: unknown): value is PastRecord {
  const row = value as Partial<PastRecord> | null
  return typeof row?.childId === 'string' && SIDECHAT_ID.test(row.childId)
    && typeof row.parentSessionId === 'string' && typeof row.createdAt === 'number'
    && (row.preview === undefined || typeof row.preview === 'string')
}

/** Disposable, versioned derivative of the store; a missing or corrupt index is rebuilt. */
export class PastIndex {
  readonly rows = new Map<string, PastRecord>()
  readonly ready: Promise<void>
  private imported = false
  private importing?: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'))
      if (data?.version !== 1 || !Array.isArray(data.rows) || !data.rows.every(isRecord)) return
      for (const row of data.rows) this.rows.set(row.childId, row)
      this.imported = data.imported === true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[dsh-side-chat] past index read failed:', error)
    }
  }

  /** Share concurrent first opens. A failed import remains retryable. */
  async discover(importHeaders: () => Promise<PastRecord[]>): Promise<void> {
    await this.ready
    if (this.imported) return
    this.importing ??= importHeaders().then(async rows => {
      for (const row of rows) if (!this.rows.has(row.childId)) this.rows.set(row.childId, row)
      this.imported = true
      await this.save()
    }).finally(() => { this.importing = undefined })
    await this.importing
  }

  /** Serialize atomic replacements: interruptions leave the last complete generation readable. */
  save(): Promise<void> {
    this.writes = this.writes.then(async () => {
      const tmp = `${this.path}.${randomUUID()}.tmp`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, imported: this.imported, rows: [...this.rows.values()] }), { mode: 0o600 })
        await rename(tmp, this.path)
      } finally {
        await unlink(tmp).catch(() => {})
      }
    }).catch(error => { console.warn('[dsh-side-chat] past index write failed:', error) })
    return this.writes
  }
}
