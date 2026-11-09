/** Prices in side-chat replies must render as text, not as inline LaTeX. */
import { expect, test } from 'vitest'
import { escapeCurrency as esc } from '../src/client/currency.ts'

test('the sentence that broke', () => {
  const md = "For violin I'd budget **roughly $150–600 in GPU rental and about 6–10 weeks of full-time work**. Adding flute, viola, cello and guitar costs **another $250–900 and 4–8 weeks**, mostly for gathering data."
  expect(esc(md)).toBe(md.replace('$150', '\\$150').replace('$250', '\\$250'))
})

test('several prices on one line', () => {
  expect(esc('the hoodie is $45 and the T-shirt is $25, so the pair is $70.'))
    .toBe('the hoodie is \\$45 and the T-shirt is \\$25, so the pair is \\$70.')
})

test('real math is kept', () => {
  for (const m of ['$E = mc^2$', '$x^2$', '$\\alpha + \\beta$', '$2^{10}$', '$a_1 + a_2$', 'cost $$x = 5$$ ok']) {
    expect(esc(m)).toBe(m)
  }
})

test('math next to a price', () => {
  expect(esc('area $x^2$ costs $5')).toBe('area $x^2$ costs \\$5')
})

test('already escaped and no-digit dollars untouched', () => {
  expect(esc('price \\$5 and a lone $ sign')).toBe('price \\$5 and a lone $ sign')
})

test('code is untouched', () => {
  const md = 'run `echo $1` then pay $5\n```sh\nexport A=$100\n```\nafter $7'
  expect(esc(md)).toBe('run `echo $1` then pay \\$5\n```sh\nexport A=$100\n```\nafter \\$7')
})

test('display math block untouched', () => {
  expect(esc('$$\nx = $5\n$$\nthen $6')).toBe('$$\nx = $5\n$$\nthen \\$6')
})

test('tables with prices', () => {
  expect(esc('| GPU | $1.20/h | $2.50/h |')).toBe('| GPU | \\$1.20/h | \\$2.50/h |')
})
