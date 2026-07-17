import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { textInVisualOrder } from '../src/visual-order'

const PAGE_HEIGHT = 842
const pageViewport = [1, 0, 0, -1, 0, PAGE_HEIGHT]

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

// Amount-heavy token mix: fused numbers are the costliest corruption.
function randomToken(random: () => number): string {
  const digits = (count: number) => Array.from(
    { length: count },
    () => '0123456789'.charAt(Math.floor(random() * 10)),
  ).join('')
  const roll = random()
  if (roll < 0.25) {
    return `$${digits(1)},${digits(3)}.${digits(2)}`
  }
  if (roll < 0.45) {
    return `(${digits(3)}.${digits(2)})`
  }
  if (roll < 0.6) {
    return `${digits(2)}.${digits(1)}%`
  }
  if (roll < 0.75) {
    return digits(5)
  }
  return randomWord(random)
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

// The upright viewport is self-inverse, so it maps display coordinates back
// to PDF coordinates as well.
const displayToPdf = [1, 0, 0, -1, 0, PAGE_HEIGHT]

/**
 * Authors a run so that its rendered geometry equals upright text at the
 * local position, transformed by the block's display-space placement matrix.
 */
function placedRun(
  str: string,
  size: number,
  localX: number,
  localY: number,
  blockPlacement: number[],
  dir = 'ltr',
): VisualOrderItem {
  const display = multiplyMatrices([size, 0, 0, -size, localX, localY], blockPlacement)
  return {
    str,
    transform: multiplyMatrices(display, displayToPdf),
    width: str.length * (size / 2),
    dir,
  }
}

function rotationAbout(angle: number, offsetX: number, offsetY: number): number[] {
  return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), offsetX, offsetY]
}

const mirrorLocal = [1, 0, 0, -1, 0, 0]

function outputTokens(text: string): string[] {
  return text.split(/\s+/).filter(token => token.length > 0).sort()
}

describe('visual order fuzzing', () => {
  it('never fuses, drops, or invents tokens under arbitrary text orientations', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = mulberry32(seed)
      const items: VisualOrderItem[] = []
      const expectedTokens: string[] = []

      const blockCount = 1 + Math.floor(random() * 3)
      for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
        const size = 4 + random() * 20
        const orientationRoll = random()
        // Diagonal text is watermark-style: sparse single-token lines. Axis
        // and near-axis text carries dense multi-token lines.
        const diagonal = orientationRoll >= 0.8
        const axisAngle = (Math.PI / 2) * Math.floor(random() * 4)
        const angle = orientationRoll < 0.5
          ? axisAngle
          : diagonal
            ? axisAngle + (Math.PI / 6) + random() * (Math.PI / 6)
            : axisAngle + (random() - 0.5) * (Math.PI / 7.5)

        let placement = rotationAbout(angle, blockIndex * 1500, blockIndex * 1500)
        if (random() < 0.1) {
          placement = multiplyMatrices(mirrorLocal, placement)
        }
        const rightToLeft = random() < 0.1

        const lineCount = 1 + Math.floor(random() * 4)
        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
          const tokensInLine = diagonal ? 1 : 1 + Math.floor(random() * 4)
          let localX = 0
          for (let tokenIndex = 0; tokenIndex < tokensInLine; tokenIndex++) {
            const token = randomToken(random)
            items.push(placedRun(
              token,
              size,
              localX,
              lineIndex * size * (diagonal ? 2 : 1.6),
              placement,
              rightToLeft ? 'rtl' : 'ltr',
            ))
            expectedTokens.push(token)
            localX += token.length * (size / 2) + (0.3 + random() * 1.5) * size
          }
        }
      }

      const text = textInVisualOrder(shuffled(items, random), pageViewport)
      expect(outputTokens(text), `seed ${seed}`).toEqual([...expectedTokens].sort())
    }
  })

  it('separates runs above the word-gap threshold and joins them below it', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = mulberry32(500 + seed)
      const size = 3 + random() * 33
      const first = randomToken(random)
      const second = randomToken(random)
      const joined = random() < 0.5
      const gap = joined
        ? (-0.2 + random() * 0.25) * size
        : (0.15 + random() * 1.8) * size

      const x = 40 + random() * 200
      const y = 40 + random() * 700
      const firstWidth = first.length * (size / 2)
      const text = textInVisualOrder([
        placedRun(first, size, x, y, [1, 0, 0, 1, 0, 0]),
        placedRun(second, size, x + firstWidth + gap, y, [1, 0, 0, 1, 0, 0]),
      ], pageViewport)

      const label = `seed ${seed} size ${size.toFixed(1)} gap ${(gap / size).toFixed(2)}em`
      if (joined) {
        expect(text, label).toBe(first + second)
      }
      else {
        expect(outputTokens(text), label).toEqual([first, second].sort())
        expect(text, label).toMatch(/[\t ]/)
      }
    }
  })

  it('reads mixed upright and rotated blocks in page order', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = mulberry32(2000 + seed)
      const items: VisualOrderItem[] = []

      const paragraphLines: string[] = []
      const paragraphCount = 2 + Math.floor(random() * 2)
      for (let lineIndex = 0; lineIndex < paragraphCount; lineIndex++) {
        const words = Array.from({ length: 2 + Math.floor(random() * 3) }, () => randomWord(random))
        let localX = 57
        for (const word of words) {
          items.push(placedRun(word, 10, localX, 50 + lineIndex * 14, [1, 0, 0, 1, 0, 0]))
          localX += word.length * 5 + 3
        }
        paragraphLines.push(words.join(' '))
      }

      const angle = (Math.PI / 2) * (1 + Math.floor(random() * 3))
      const rotatedAboveParagraph = random() < 0.5
      const placement = rotationAbout(angle, 300, rotatedAboveParagraph ? -2500 : 2500)
      const tableRows: string[] = []
      const rowCount = 2 + Math.floor(random() * 3)
      const columnCount = 2 + Math.floor(random() * 2)
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const cells: string[] = []
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
          const cell = randomToken(random)
          items.push(placedRun(cell, 10, columnIndex * 120, rowIndex * 16, placement))
          cells.push(cell)
        }
        tableRows.push(cells.join('\t'))
      }

      const paragraphText = paragraphLines.join('\n')
      const tableText = tableRows.join('\n')
      const expected = rotatedAboveParagraph
        ? `${tableText}\n${paragraphText}`
        : `${paragraphText}\n${tableText}`
      expect(textInVisualOrder(shuffled(items, random), pageViewport), `seed ${seed}`)
        .toBe(expected)
    }
  })
})
