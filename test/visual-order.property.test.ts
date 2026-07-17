import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { textInVisualOrder } from '../src/visual-order'

const pageViewport = [1, 0, 0, -1, 0, 842]

const FONT_SIZE = 10
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

function textRun(str: string, x: number, y: number, dir = 'ltr'): VisualOrderItem {
  return {
    str,
    transform: [FONT_SIZE, 0, 0, FONT_SIZE, x, y],
    width: str.length * (FONT_SIZE / 2),
    dir,
  }
}

interface GeneratedBlock {
  items: VisualOrderItem[]
  text: string
  bottom: number
}

function paragraphBlock(random: () => number, topY: number): GeneratedBlock {
  const items: VisualOrderItem[] = []
  const lines: string[] = []
  const lineCount = 1 + Math.floor(random() * 4)

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const y = topY - lineIndex * LINE_ADVANCE
    const words = Array.from({ length: 1 + Math.floor(random() * 5) }, () => randomWord(random))
    const rightToLeft = random() < 0.25
    let x = 57
    for (const word of rightToLeft ? [...words].reverse() : words) {
      items.push(textRun(word, x, y, rightToLeft ? 'rtl' : 'ltr'))
      x += word.length * (FONT_SIZE / 2) + WORD_GAP
    }
    lines.push(words.join(' '))
  }

  return { items, text: lines.join('\n'), bottom: topY - (lineCount - 1) * LINE_ADVANCE }
}

function tableBlock(random: () => number, topY: number): GeneratedBlock {
  const columnStarts = [57, 260, 420].slice(0, 2 + Math.floor(random() * 2))
  const rowCount = 2 + Math.floor(random() * 4)
  const items: VisualOrderItem[] = []
  const rows: string[] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const y = topY - rowIndex * LINE_ADVANCE
    const cells = columnStarts.map(() => randomWord(random))
    for (const [columnIndex, x] of columnStarts.entries()) {
      items.push(textRun(cells[columnIndex]!, x, y))
    }
    rows.push(cells.join('\t'))
  }

  return { items, text: rows.join('\n'), bottom: topY - (rowCount - 1) * LINE_ADVANCE }
}

function columnsBlock(random: () => number, topY: number): GeneratedBlock {
  const prose = (startX: number, startY: number) => {
    const lineCount = 4 + Math.floor(random() * 3)
    const items: VisualOrderItem[] = []
    const lines: string[] = []
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const y = startY - lineIndex * LINE_ADVANCE
      const words = Array.from({ length: 1 + Math.floor(random() * 4) }, () => randomWord(random))
      let x = startX
      for (const word of words) {
        items.push(textRun(word, x, y))
        x += word.length * (FONT_SIZE / 2) + WORD_GAP
      }
      lines.push(words.join(' '))
    }
    return { items, lines, bottom: startY - (lineCount - 1) * LINE_ADVANCE }
  }

  // Offset baselines mark the sides as facing prose columns, not table rows.
  const left = prose(57, topY)
  const right = prose(320, topY - 7)
  return {
    items: [...left.items, ...right.items],
    text: [...left.lines, ...right.lines].join('\n'),
    bottom: Math.min(left.bottom, right.bottom),
  }
}

function generatePage(seed: number): { items: VisualOrderItem[], expected: string } {
  const random = mulberry32(seed)
  const blocks: GeneratedBlock[] = []
  let topY = 800

  const blockCount = 1 + Math.floor(random() * 3)
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const roll = random()
    const block = roll < 1 / 3
      ? paragraphBlock(random, topY)
      : roll < 2 / 3
        ? tableBlock(random, topY)
        : columnsBlock(random, topY)
    blocks.push(block)
    topY = block.bottom - BLOCK_GAP
  }

  return {
    items: shuffled(blocks.flatMap(block => block.items), random),
    expected: blocks.map(block => block.text).join('\n'),
  }
}

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

function chaosText(random: () => number): string {
  const roll = random()
  if (roll < 0.08) {
    return ''
  }
  if (roll < 0.16) {
    return '   '
  }
  return Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomWord(random)).join(' ')
}

const chaosViewports = [
  [1, 0, 0, -1, 0, 842],
  [0, 1, 1, 0, 0, 0],
  [2, 0, 0, -2, 0, 1684],
  [0, -1, -1, 0, 595, 842],
]

describe('textInVisualOrder properties', () => {
  it('reconstructs shuffled synthetic pages across seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { items, expected } = generatePage(seed)
      expect(textInVisualOrder(items, pageViewport), `seed ${seed}`).toBe(expected)
    }
  })

  it('never drops visible characters, whatever the geometry', () => {
    const visibleCharacters = (value: string) => [...value.replace(/\s/g, '')].sort()

    for (let seed = 1; seed <= 60; seed++) {
      const random = mulberry32(1000 + seed)
      const items: VisualOrderItem[] = Array.from(
        { length: 1 + Math.floor(random() * 40) },
        () => ({
          str: chaosText(random),
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
