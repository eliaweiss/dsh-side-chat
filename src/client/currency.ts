/**
 * Keep prices such as `$150–600` from being drawn as LaTeX math.
 *
 * DSH's `MarkdownText` always treats a `$…$` pair as inline math, so a reply
 * with two prices on one line turns into one italic formula with the words run
 * together, and bold markers in between break. The main conversation is fixed
 * by the local `dsh-currency-fix` plugin, which wraps the built-in
 * `assistant-step` renderer; the side chat renders `MarkdownText` itself, so it
 * escapes here, on the text it is about to render. Stored and inserted text is
 * never changed.
 *
 * Escaped: a `$` directly followed by a digit (`$5`, `$1.20/h`, `$150–600`),
 * unless the text up to the next `$` on that line looks like TeX
 * (contains \ ^ _ { }), e.g. `$2^{10}$`.
 * Untouched: fenced code, inline code, `$$` display math, existing `\$`, and
 * math that does not start with a digit (`$x^2$`, `$\alpha$`).
 */

const TEX_HINT = /[\\^_{}]/

/** Index of the next unescaped single `$` after `from`, or -1. */
function findClosing(text: string, from: number): number {
  for (let j = from; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\\') { j += 1; continue }
    if (c === '$') return text[j + 1] === '$' ? -1 : j
  }
  return -1
}

/** Escape currency dollars in one run of plain (non-code) Markdown text. */
function escapeSegment(text: string): string {
  if (!text.includes('$')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch !== '$') {
      out += ch
      i += 1
      continue
    }
    if (text[i + 1] === '$') {
      out += '$$'
      i += 2
      continue
    }
    const close = findClosing(text, i + 1)
    const next = text[i + 1]
    if (next !== undefined && next >= '0' && next <= '9') {
      const body = close === -1 ? '' : text.slice(i + 1, close)
      if (close !== -1 && TEX_HINT.test(body)) {
        out += text.slice(i, close + 1)
        i = close + 1
      } else {
        out += '\\$'
        i += 1
      }
      continue
    }
    if (close !== -1 && next !== ' ' && next !== undefined) {
      // Ordinary inline math such as `$x^2$`: copy it whole so its closing
      // `$` is not mistaken for the start of a price.
      out += text.slice(i, close + 1)
      i = close + 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Escape outside inline code spans on one line. */
function escapeLine(line: string): string {
  if (!line.includes('$')) return line
  if (!line.includes('`')) return escapeSegment(line)
  let out = ''
  let last = 0
  const code = /(`+)[\s\S]*?\1(?!`)/g
  let m: RegExpExecArray | null
  while ((m = code.exec(line)) !== null) {
    out += escapeSegment(line.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + escapeSegment(line.slice(last))
}

/** Escape currency dollars in a Markdown document, skipping code and display math. */
export function escapeCurrency(markdown: string): string {
  if (!markdown.includes('$')) return markdown
  const lines = markdown.split('\n')
  let fence: string | null = null
  let displayMath = false
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (open !== null && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.trim() === open[1]) fence = null
      continue
    }
    if (open !== null) { fence = open[1]!; continue }
    if (line.trim() === '$$') { displayMath = !displayMath; continue }
    if (displayMath) continue
    lines[n] = escapeLine(line)
  }
  return lines.join('\n')
}
