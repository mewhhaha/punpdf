import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { textInVisualOrder } from '../src/visual-order'

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const pageViewport = [1, 0, 0, -1, 0, PAGE_HEIGHT]

const FONT_SIZE = 10
const HEADING_SIZE = 14
const LINE_ADVANCE = 14
const WORD_GAP = 3
// Keeps generated blocks far enough apart that block segmentation must
// separate them, and word gaps far enough from every heuristic threshold
// that the expected text is unambiguous.
const BLOCK_GAP = 30

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    const held = copy[index]!
    copy[index] = copy[swap]!
    copy[swap] = held
  }
  return copy
}

function randomWord(random: () => number): string {
  const length = 2 + Math.floor(random() * 7)
  let word = ''
  for (let index = 0; index < length; index++) {
    word += 'abcdefghijklmnopqrstuvwxyz'.charAt(Math.floor(random() * 26))
  }
  return word
}

function wordWidth(word: string, size: number): number {
  return word.length * (size / 2)
}

function textRun(
  str: string,
  x: number,
  y: number,
  options: { size?: number, dir?: string } = {},
): VisualOrderItem {
  const { size = FONT_SIZE, dir = 'ltr' } = options
  return { str, transform: [size, 0, 0, size, x, y], width: wordWidth(str, size), dir }
}

interface GeneratedBlock {
  items: VisualOrderItem[]
  text: string
  bottom: number
}

function headingBlock(random: () => number, topY: number): GeneratedBlock {
  const words = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomWord(random))
  const items: VisualOrderItem[] = []
  let x = 57
  for (const word of words) {
    items.push(textRun(word, x, topY, { size: HEADING_SIZE }))
    x += wordWidth(word, HEADING_SIZE) + 4
  }
  return { items, text: words.join(' '), bottom: topY }
}

function paragraphBlock(random: () => number, topY: number): GeneratedBlock {
  const items: VisualOrderItem[] = []
  const lines: string[] = []
  const lineEnds: Array<{ lineIndex: number, x: number, y: number }> = []
  const lineCount = 1 + Math.floor(random() * 4)

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const y = topY - lineIndex * LINE_ADVANCE
    const indent = [0, 20, 45][Math.floor(random() * 3)]!
    const words = Array.from({ length: 1 + Math.floor(random() * 5) }, () => randomWord(random))
    const rightToLeft = random() < 0.2

    let x = 57 + indent
    const placed = rightToLeft ? [...words].reverse() : words
    for (const [wordIndex, word] of placed.entries()) {
      items.push(textRun(word, x, y, { dir: rightToLeft ? 'rtl' : 'ltr' }))
      x += wordWidth(word, FONT_SIZE) + WORD_GAP
      // Sometimes the producer emits the inter-word space as its own run.
      if (!rightToLeft && wordIndex < placed.length - 1 && random() < 0.2) {
        items.push(textRun(' ', x - WORD_GAP, y))
      }
    }
    lines.push(words.join(' '))
    if (!rightToLeft) {
      lineEnds.push({ lineIndex, x: x - WORD_GAP, y })
    }
  }

  // A raised smaller run abutting a word must stay joined to it. Skipped
  // when other lines start within the column-evidence window of its x, so
  // the expected text never depends on coincidental alignment.
  if (lineEnds.length > 0 && random() < 0.35) {
    const target = lineEnds[Math.floor(random() * lineEnds.length)]!
    const superscript = randomWord(random)
    const supBucket = Math.round(target.x * 2)
    const conflictingBaselines = new Set<number>()
    for (const item of items) {
      if (item.str.trim().length === 0) {
        continue
      }
      const [, , , , x, y] = item.transform
      if (Math.abs(Math.round(x * 2) - supBucket) <= 2) {
        conflictingBaselines.add(y)
      }
    }
    if (conflictingBaselines.size < 2) {
      items.push(textRun(superscript, target.x, target.y + 3.5, { size: 7 }))
      lines[target.lineIndex] += superscript
    }
  }

  return { items, text: lines.join('\n'), bottom: topY - (lineCount - 1) * LINE_ADVANCE }
}

function tableBlock(random: () => number, topY: number): GeneratedBlock {
  const columnStarts = [57, 260, 420].slice(0, 2 + Math.floor(random() * 2))
  const rightAlignLastColumn = random() < 0.4
  const lastColumnRightEdge = columnStarts.at(-1)! + 120
  const rowCount = 2 + Math.floor(random() * 4)
  const items: VisualOrderItem[] = []
  const rows: string[] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const y = topY - rowIndex * LINE_ADVANCE
    const cells: string[] = []
    for (const [columnIndex, columnStart] of columnStarts.entries()) {
      const words = Array.from(
        { length: random() < 0.4 ? 2 : 1 },
        () => randomWord(random),
      )
      const cellWidth = words.reduce(
        (total, word) => total + wordWidth(word, FONT_SIZE),
        (words.length - 1) * WORD_GAP,
      )
      const lastColumn = columnIndex === columnStarts.length - 1
      let x = lastColumn && rightAlignLastColumn ? lastColumnRightEdge - cellWidth : columnStart
      for (const word of words) {
        items.push(textRun(word, x, y))
        x += wordWidth(word, FONT_SIZE) + WORD_GAP
      }
      cells.push(words.join(' '))
    }
    rows.push(cells.join('\t'))
  }

  return { items, text: rows.join('\n'), bottom: topY - (rowCount - 1) * LINE_ADVANCE }
}

// Cells whose overstated font metrics overlap the next column must still
// separate through repeated start-x alignment.
function overlappingTableBlock(random: () => number, topY: number): GeneratedBlock {
  const rowCount = 3 + Math.floor(random() * 3)
  const items: VisualOrderItem[] = []
  const rows: string[] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const y = topY - rowIndex * LINE_ADVANCE
    const label = randomWord(random)
    const amount = randomWord(random)
    items.push({ ...textRun(label, 57, y), width: (260 - 57) + 20 })
    items.push(textRun(amount, 260, y))
    rows.push(`${label} ${amount}`)
  }

  return { items, text: rows.join('\n'), bottom: topY - (rowCount - 1) * LINE_ADVANCE }
}

function columnsBlock(random: () => number, topY: number): GeneratedBlock {
  const columnStarts = random() < 0.4 ? [57, 250, 443] : [57, 320]
  const maxWordsPerLine = columnStarts.length === 3 ? 3 : 4
  // Offset baselines mark the sides as facing prose columns, not table rows.
  const baselineOffsets = [0, 7, 3]

  const columns = columnStarts.map((startX, columnIndex) => {
    const lineCount = 4 + Math.floor(random() * 3)
    const items: VisualOrderItem[] = []
    const lines: string[] = []
    const columnTop = topY - baselineOffsets[columnIndex]!
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const y = columnTop - lineIndex * LINE_ADVANCE
      const words = Array.from(
        { length: 1 + Math.floor(random() * maxWordsPerLine) },
        () => randomWord(random),
      )
      let x = startX
      for (const word of words) {
        items.push(textRun(word, x, y))
        x += wordWidth(word, FONT_SIZE) + WORD_GAP
      }
      lines.push(words.join(' '))
    }
    return { items, lines, bottom: columnTop - (lineCount - 1) * LINE_ADVANCE }
  })

  return {
    items: columns.flatMap(column => column.items),
    text: columns.flatMap(column => column.lines).join('\n'),
    bottom: Math.min(...columns.map(column => column.bottom)),
  }
}

function generatePage(seed: number): { items: VisualOrderItem[], expected: string } {
  const random = mulberry32(seed)
  const blocks: GeneratedBlock[] = []
  let topY = 800

  const blockCount = 2 + Math.floor(random() * 3)
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const roll = random()
    const block = roll < 0.18
      ? headingBlock(random, topY)
      : roll < 0.45
        ? paragraphBlock(random, topY)
        : roll < 0.65
          ? tableBlock(random, topY)
          : roll < 0.78
            ? overlappingTableBlock(random, topY)
            : columnsBlock(random, topY)
    blocks.push(block)
    topY = block.bottom - BLOCK_GAP
  }

  return {
    items: shuffled(blocks.flatMap(block => block.items), random),
    expected: blocks.map(block => block.text).join('\n'),
  }
}

// Row-vector convention, matching how the viewport is applied to items.
function multiplyMatrices(m: number[], n: number[]): number[] {
  const [ma, mb, mc, md, me, mf] = m as [number, number, number, number, number, number]
  const [na, nb, nc, nd, ne, nf] = n as [number, number, number, number, number, number]
  return [
    ma * na + mb * nc,
    ma * nb + mb * nd,
    mc * na + md * nc,
    mc * nb + md * nd,
    me * na + mf * nc + ne,
    me * nb + mf * nd + nf,
  ]
}

function invertMatrix(m: number[]): number[] {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number]
  const determinant = a * d - b * c
  const ia = d / determinant
  const ib = -b / determinant
  const ic = -c / determinant
  const id = a / determinant
  return [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)]
}

// PDF.js viewport transforms for each page rotation at scale 1.
const rotatedViewports = [
  { rotation: 90, viewport: [0, 1, 1, 0, 0, 0] },
  { rotation: 180, viewport: [-1, 0, 0, 1, PAGE_WIDTH, 0] },
  { rotation: 270, viewport: [0, -1, -1, 0, PAGE_HEIGHT, PAGE_WIDTH] },
]

// Pure rotations of the display plane: content authored sideways on a page
// whose viewport stays upright (sideways tables, rotated chart labels).
const contentRotations = [
  { rotation: 90, matrix: [0, 1, -1, 0, 0, 0] },
  { rotation: 180, matrix: [-1, 0, 0, -1, 0, 0] },
  { rotation: 270, matrix: [0, -1, 1, 0, 0, 0] },
]

function chaosCoordinate(random: () => number): number {
  const roll = random()
  if (roll < 0.05) {
    return Number.NaN
  }
  if (roll < 0.08) {
    return Number.POSITIVE_INFINITY
  }
  if (roll < 0.11) {
    return Number.NEGATIVE_INFINITY
  }
  if (roll < 0.18) {
    return 0
  }
  return (random() - 0.5) * 1200
}

// Visible chaos text is unique per item so that duplicate-draw removal
// (which intentionally drops repeated runs) cannot void the conservation
// oracle when random geometry collides.
function chaosText(random: () => number, index: number): string {
  const roll = random()
  if (roll < 0.08) {
    return ''
  }
  if (roll < 0.16) {
    return '   '
  }
  const words = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomWord(random))
  return `${index}${words.join(' ')}`
}

const chaosViewports = [
  [1, 0, 0, -1, 0, 842],
  [0, 1, 1, 0, 0, 0],
  [2, 0, 0, -2, 0, 1684],
  [0, -1, -1, 0, 595, 842],
]

describe('textInVisualOrder properties', () => {
  it('reconstructs shuffled synthetic pages across seeds', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { items, expected } = generatePage(seed)
      expect(textInVisualOrder(items, pageViewport), `seed ${seed}`).toBe(expected)
    }
  })

  it('reads the same text at every page rotation', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { items, expected } = generatePage(seed)
      for (const { rotation, viewport } of rotatedViewports) {
        const reauthored = items.map(item => ({
          ...item,
          transform: multiplyMatrices(
            item.transform,
            multiplyMatrices(pageViewport, invertMatrix(viewport)),
          ),
        }))
        expect(textInVisualOrder(reauthored, viewport), `seed ${seed} rotation ${rotation}`)
          .toBe(expected)
      }
    }
  })

  it('reads sideways-authored content identically to upright content', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { items, expected } = generatePage(seed)
      for (const { rotation, matrix } of contentRotations) {
        const sideways = items.map(item => ({
          ...item,
          transform: multiplyMatrices(
            item.transform,
            multiplyMatrices(pageViewport, multiplyMatrices(matrix, invertMatrix(pageViewport))),
          ),
        }))
        expect(textInVisualOrder(sideways, pageViewport), `seed ${seed} content rotation ${rotation}`)
          .toBe(expected)
      }
    }
  })

  it('never drops visible characters, whatever the geometry', () => {
    const visibleCharacters = (value: string) => [...value.replace(/\s/g, '')].sort()

    for (let seed = 1; seed <= 60; seed++) {
      const random = mulberry32(1000 + seed)
      const items: VisualOrderItem[] = Array.from(
        { length: 1 + Math.floor(random() * 40) },
        (_, index) => ({
          str: chaosText(random, index),
          transform: Array.from({ length: 6 }, () => chaosCoordinate(random)),
          width: chaosCoordinate(random),
          dir: random() < 0.2 ? 'rtl' : 'ltr',
        }),
      )

      const text = textInVisualOrder(items, chaosViewports[seed % chaosViewports.length]!)
      expect(visibleCharacters(text), `seed ${seed}`)
        .toEqual(visibleCharacters(items.map(item => item.str).join('')))
    }
  })
})
