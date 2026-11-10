/**
 * Copy a side-chat reply to the clipboard, like the main conversation's Copy.
 *
 * DSH's own `useClipboardCopy` only exists from 0.2.2 on, and the plugin still
 * supports 0.2.1-rc.1, so the copy lives here instead of being imported.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** The parts of the browser this needs, so tests can pass their own. */
export interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> }
  /** Fallback for pages where the async clipboard is missing or refused. */
  legacyCopy?: (text: string) => boolean
}

/** Old-style copy through a hidden textarea; works where the async clipboard is blocked. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

function browserEnv(): ClipboardEnv {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  return { clipboard: clipboard ?? undefined, legacyCopy }
}

/**
 * Write text to the clipboard.
 * @returns true when the text was copied.
 */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.clipboard !== undefined) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path (e.g. no permission, document not focused).
    }
  }
  return env.legacyCopy?.(text) ?? false
}

/** How long the button shows "Copied", matching the main conversation. */
export const COPIED_MS = 1000

/**
 * Copy action with a short "Copied" state, cleared on unmount.
 * @param text - Exact text the button copies.
 */
export function useCopyText(text: string): { copied: boolean; onCopy: () => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const onCopy = useCallback(() => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, COPIED_MS)
    })
  }, [text])
  return { copied, onCopy }
}
