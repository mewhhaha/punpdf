import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { textInVisualOrder } from '../src/visual-order'

// An unrotated 100pt-tall page: PDF coordinates are bottom-up, so the
// viewport flips the y axis to make y grow downward.
const pageViewport = [1, 0, 0, -1, 0, 100]

function run(
  str: string,
  position: { x: number, y: number, width: number, fontSize?: number },
): VisualOrderItem {
  const { x, y, width, fontSize = 10 } = position
  return { str, transform: [fontSize, 0, 0, fontSize, x, y], width }
}

describe('textInVisualOrder', () => {
  it('orders lines top to bottom regardless of content-stream order', () => {
    const text = textInVisualOrder([
      run('World', { x: 10, y: 50, width: 30 }),
      run('Hello', { x: 10, y: 80, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Hello\nWorld')
  })

  it('orders a rotated page by its rendered position', () => {
    const text = textInVisualOrder([
      run('second', { x: 20, y: 5, width: 30 }),
      run('first', { x: 10, y: 5, width: 20 }),
    ], [0, 1, 1, 0, 0, 0])

    expect(text).toBe('first\nsecond')
  })

  it('merges runs with small baseline jitter into one line', () => {
    const text = textInVisualOrder([
      run('Hello', { x: 10, y: 80.5, width: 30 }),
      run('world', { x: 45, y: 80, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Hello world')
  })

  it('infers a space between runs separated by a word gap', () => {
    const text = textInVisualOrder([
      run('Hello', { x: 10, y: 80, width: 30 }),
      run('world', { x: 44, y: 80, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Hello world')
  })

  it('joins abutting runs without a space even when their metrics overlap', () => {
    const text = textInVisualOrder([
      run('Val', { x: 10, y: 80, width: 12 }),
      run('ue', { x: 21.8, y: 80, width: 10 }),
    ], pageViewport)

    expect(text).toBe('Value')
  })

  it('collapses whitespace-only runs into a single space', () => {
    const text = textInVisualOrder([
      run('Hello', { x: 10, y: 80, width: 30 }),
      run('   ', { x: 40, y: 80, width: 8 }),
      run('world', { x: 48, y: 80, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Hello world')
  })

  it('keeps a superscript run inline with its anchor text', () => {
    const text = textInVisualOrder([
      run('E=mc', { x: 10, y: 20, width: 22 }),
      run('2', { x: 32, y: 24, width: 4, fontSize: 7 }),
    ], pageViewport)

    expect(text).toBe('E=mc2')
  })

  it('keeps a subscript run inline with its anchor text', () => {
    const text = textInVisualOrder([
      run('H', { x: 10, y: 20, width: 7 }),
      run('2', { x: 17, y: 17, width: 4, fontSize: 7 }),
      run('O', { x: 21, y: 20, width: 7 }),
    ], pageViewport)

    expect(text).toBe('H2O')
  })

  it('does not treat near-aligned word seams as a column boundary', () => {
    const text = textInVisualOrder([
      run('inter', { x: 70, y: 80, width: 30 }),
      run('nal', { x: 100, y: 80, width: 18 }),
      run('exter', { x: 72, y: 65, width: 30 }),
      run('nal', { x: 102, y: 65, width: 18 }),
      run('inter', { x: 68, y: 50, width: 30 }),
      run('face', { x: 98, y: 50, width: 24 }),
    ], pageViewport)

    expect(text).toBe('internal\nexternal\ninterface')
  })

  it('separates aligned columns when font metrics overlap', () => {
    const text = textInVisualOrder([
      run('Report', { x: 10, y: 95, width: 35 }),
      run('s', { x: 43, y: 95, width: 5 }),
      run('Full Renovation', { x: 10, y: 80, width: 100 }),
      run('A1', { x: 58, y: 80, width: 10 }),
      run('Full Renovation', { x: 10, y: 65, width: 100 }),
      run('A2', { x: 58, y: 65, width: 10 }),
      run('Full Renovation', { x: 10, y: 50, width: 100 }),
      run('A3', { x: 58, y: 50, width: 10 }),
    ], pageViewport)

    expect(text).toBe('Reports\nFull Renovation A1\nFull Renovation A2\nFull Renovation A3')
  })

  it('separates runs across a wide gap with a tab', () => {
    const text = textInVisualOrder([
      run('Subtotal', { x: 10, y: 80, width: 40 }),
      run('120.00', { x: 110, y: 80, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Subtotal\t120.00')
  })

  it('reads facing columns of prose column by column', () => {
    const text = textInVisualOrder([
      run('L1', { x: 10, y: 80, width: 30 }),
      run('R1', { x: 60, y: 74, width: 30 }),
      run('L2', { x: 10, y: 68, width: 30 }),
      run('R2', { x: 60, y: 62, width: 30 }),
      run('L3', { x: 10, y: 56, width: 30 }),
      run('R3', { x: 60, y: 50, width: 30 }),
      run('L4', { x: 10, y: 44, width: 30 }),
      run('R4', { x: 60, y: 38, width: 30 }),
    ], pageViewport)

    expect(text).toBe('L1\nL2\nL3\nL4\nR1\nR2\nR3\nR4')
  })

  it('reads a full-width heading before the columns below it', () => {
    const text = textInVisualOrder([
      run('Annual Report', { x: 10, y: 90, width: 80, fontSize: 12 }),
      run('L1', { x: 10, y: 60, width: 30 }),
      run('R1', { x: 60, y: 54, width: 30 }),
      run('L2', { x: 10, y: 48, width: 30 }),
      run('R2', { x: 60, y: 42, width: 30 }),
      run('L3', { x: 10, y: 36, width: 30 }),
      run('R3', { x: 60, y: 30, width: 30 }),
      run('L4', { x: 10, y: 24, width: 30 }),
      run('R4', { x: 60, y: 18, width: 30 }),
    ], pageViewport)

    expect(text).toBe('Annual Report\nL1\nL2\nL3\nL4\nR1\nR2\nR3\nR4')
  })

  it('keeps table rows together when baselines align across the gutter', () => {
    const text = textInVisualOrder([
      run('Row1', { x: 10, y: 80, width: 30 }),
      run('A', { x: 80, y: 80, width: 10 }),
      run('Row2', { x: 10, y: 65, width: 30 }),
      run('B', { x: 80, y: 65, width: 10 }),
      run('Row3', { x: 10, y: 50, width: 30 }),
      run('C', { x: 80, y: 50, width: 10 }),
      run('Row4', { x: 10, y: 35, width: 30 }),
      run('D', { x: 80, y: 35, width: 10 }),
    ], pageViewport)

    expect(text).toBe('Row1\tA\nRow2\tB\nRow3\tC\nRow4\tD')
  })

  it('returns an empty string when the page has no visible text', () => {
    expect(textInVisualOrder([], pageViewport)).toBe('')
    expect(textInVisualOrder([run(' ', { x: 10, y: 80, width: 5 })], pageViewport)).toBe('')
  })
})
