import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { textInVisualOrder } from '../src/visual-order'

// An unrotated 100pt-tall page: PDF coordinates are bottom-up, so the
// viewport flips the y axis to make y grow downward.
const pageViewport = [1, 0, 0, -1, 0, 100]

function run(
  str: string,
  position: { x: number, y: number, width: number, fontSize?: number, dir?: string },
): VisualOrderItem {
  const { x, y, width, fontSize = 10, dir = 'ltr' } = position
  return { str, transform: [fontSize, 0, 0, fontSize, x, y], width, dir }
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
    // Content authored sideways as on a /Rotate 90 page: a run at display
    // position (dx, dy) carries the transform [0, s, -s, 0, dy, dx].
    const text = textInVisualOrder([
      { str: 'second', transform: [0, 10, -10, 0, 50, 10], width: 30, dir: 'ltr' },
      { str: 'first', transform: [0, 10, -10, 0, 20, 10], width: 20, dir: 'ltr' },
    ], [0, 1, 1, 0, 0, 0])

    expect(text).toBe('first\nsecond')
  })

  it('reads a sideways table embedded in a portrait page row by row', () => {
    const text = textInVisualOrder([
      { str: '$1,947', transform: [0, 4, -4, 0, 50, 10], width: 12, dir: 'ltr' },
      { str: '$1,930', transform: [0, 4, -4, 0, 50, 33], width: 12, dir: 'ltr' },
      { str: '$2,006', transform: [0, 4, -4, 0, 60, 10], width: 12, dir: 'ltr' },
      { str: '$1,999', transform: [0, 4, -4, 0, 60, 33], width: 12, dir: 'ltr' },
    ], pageViewport)

    expect(text).toBe('$1,947\t$1,930\n$2,006\t$1,999')
  })

  it('keeps rotated currency values and month labels in separate columns', () => {
    const text = textInVisualOrder([
      { str: '$1,947', transform: [0, 4, -4, 0, 50, 10], width: 12, dir: 'ltr' },
      { str: '$1,930', transform: [0, 4, -4, 0, 50, 33], width: 12, dir: 'ltr' },
      { str: 'Sep', transform: [0, 4, -4, 0, 60, 10], width: 7, dir: 'ltr' },
      { str: 'Oct', transform: [0, 4, -4, 0, 60, 33], width: 7, dir: 'ltr' },
      { str: 'Dec', transform: [0, 4, -4, 0, 70, 10], width: 7, dir: 'ltr' },
      { str: 'Jan', transform: [0, 4, -4, 0, 70, 33], width: 7, dir: 'ltr' },
    ], pageViewport)

    expect(text).toBe('$1,947\t$1,930\nSep\tOct\nDec\tJan')
  })

  it('separates adjacent diagonal property headings at their PDF.js line boundaries', () => {
    const diagonalHeading = (
      str: string,
      x: number,
      y: number,
      width: number,
    ) => ({
      str,
      transform: [6.193889, 6.193889, -6.194381, 6.194381, x, y],
      width,
      dir: 'ltr',
      hasEOL: true,
    } as VisualOrderItem)
    const text = textInVisualOrder([
      diagonalHeading('Allaso High Desert', 323.644, 450.355, 66.625),
      diagonalHeading('Allegro at Tanoan', 402.365, 451.072, 64.347),
      diagonalHeading('Altezza High Desert', 478.2, 448.91, 70.654),
      diagonalHeading('Olympus Latitude', 519.485, 451.189, 64.233),
    ], [1, 0, 0, -1, 0, 842])

    expect(text).toBe(
      'Allaso High Desert Allegro at Tanoan Altezza High Desert Olympus Latitude',
    )
  })

  it('reads upright text before a sideways block that starts lower', () => {
    const text = textInVisualOrder([
      run('Report', { x: 10, y: 95, width: 30 }),
      { str: 'CONFIDENTIAL', transform: [0, 6, -6, 0, 90, 30], width: 40, dir: 'ltr' },
    ], pageViewport)

    expect(text).toBe('Report\nCONFIDENTIAL')
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

  it.each([
    ['87111', '0.12', 37.51318119468372],
    ['87111', '0.48', 37.63541711812114],
    ['87113', '4.58', 37.982381897808644],
  ])('keeps postal code %s separate from distance %s when font metrics overlap', (postalCode, distance, addressWidth) => {
    const fontSize = 1.55994
    const text = textInVisualOrder([
      run(`Example address ${postalCode}`, { x: 49.8000015, y: 80, width: addressWidth, fontSize }),
      run('-', { x: 79.9199985, y: 80, width: 0.47734164, fontSize }),
      run(' ', { x: 80.39734014, y: 80, width: 9.12354648, fontSize }),
      run(distance, { x: 87.24, y: 80, width: 2.83285104, fontSize }),
    ], pageViewport)

    expect(text.replace(/\s+/g, ' ')).toBe(`Example address ${postalCode}- ${distance}`)
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

  it('keeps a matrix identifier subscript attached to its base symbol', () => {
    const text = textInVisualOrder([
      run('𝑅', { x: 187.294, y: 413.184, width: 8.167, fontSize: 10.76 }),
      run('𝑥', { x: 195.461, y: 410.527, width: 4.881, fontSize: 7.532 }),
      run('(𝜙) =', { x: 200.944, y: 413.184, width: 26.189, fontSize: 10.76 }),
      run('⎡', { x: 230.13, y: 426.295, width: 7.177, fontSize: 10.76 }),
      run('⎢', { x: 230.13, y: 415.759, width: 7.177, fontSize: 10.76 }),
      run('⎢', { x: 230.13, y: 405.23, width: 7.177, fontSize: 10.76 }),
      run('⎣', { x: 230.13, y: 389.314, width: 7.177, fontSize: 10.76 }),
      run('1', { x: 245.184, y: 431.368, width: 5.38, fontSize: 10.76 }),
      run('0', { x: 276.592, y: 431.368, width: 5.38, fontSize: 10.76 }),
      run('0', { x: 308.102, y: 431.368, width: 5.38, fontSize: 10.76 }),
      run('0', { x: 237.307, y: 412.001, width: 5.38, fontSize: 10.76 }),
      run('cos 𝜃', { x: 252.639, y: 412.001, width: 21.239, fontSize: 10.76 }),
      run('− sin 𝜃', { x: 283.842, y: 412.001, width: 30.213, fontSize: 10.76 }),
      run('0', { x: 237.307, y: 392.634, width: 5.38, fontSize: 10.76 }),
      run('sin 𝜃', { x: 253.231, y: 392.634, width: 20.056, fontSize: 10.76 }),
      run('cos 𝜃', { x: 288.329, y: 392.634, width: 21.239, fontSize: 10.76 }),
      run('⎤', { x: 314.064, y: 426.295, width: 7.177, fontSize: 10.76 }),
      run('⎥', { x: 314.064, y: 415.759, width: 7.177, fontSize: 10.76 }),
      run('⎥', { x: 314.064, y: 405.23, width: 7.177, fontSize: 10.76 }),
      run('⎦', { x: 314.064, y: 389.314, width: 7.177, fontSize: 10.76 }),
    ], [1, 0, 0, -1, 0, 842])

    expect(text).toContain('𝑅𝑥(𝜙) =')
  })

  it('keeps a raised radical attached to its following expression', () => {
    const text = textInVisualOrder([
      run('expressions like', { x: 10, y: 50, width: 70, fontSize: 9 }),
      run('√', { x: 82, y: 58.6, width: 10, fontSize: 12 }),
      run('𝑥 < 𝑦', { x: 92, y: 50, width: 29, fontSize: 12 }),
      run('without recentering', { x: 123, y: 50, width: 90, fontSize: 9 }),
    ], pageViewport)

    expect(text).toBe('expressions like √𝑥 < 𝑦 without recentering')
  })

  it('keeps a denominator radical and exponent attached to the radicand', () => {
    const text = textInVisualOrder([
      run('𝑃𝑟𝑜𝑗 =', { x: 10, y: 50, width: 35, fontSize: 10.8 }),
      run('(𝑎 − 𝑏) ⋅ (𝑐 − 𝑏)', { x: 52, y: 57.3, width: 71, fontSize: 10.8 }),
      run('(', { x: 49.8, y: 41.2, width: 4.2, fontSize: 10.8 }),
      run('√', { x: 54, y: 50.3, width: 9, fontSize: 10.8 }),
      run('𝑐 − 𝑏 ⋅ 𝑐 − 𝑏)', { x: 63, y: 41.2, width: 57.5, fontSize: 10.8 }),
      run('2', { x: 120.5, y: 44.3, width: 4.3, fontSize: 7.5 }),
    ], pageViewport)

    expect(text).toContain('(√𝑐 − 𝑏 ⋅ 𝑐 − 𝑏)2')
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

  it('reads a contiguous right-to-left sequence from its rightmost run', () => {
    const text = textInVisualOrder([
      run('ALEPH', { x: 50, y: 80, width: 30, dir: 'rtl' }),
      run('BET', { x: 10, y: 80, width: 30, dir: 'rtl' }),
    ], pageViewport)

    expect(text).toBe('ALEPH BET')
  })

  it('keeps left-to-right runs in place around a right-to-left sequence', () => {
    const text = textInVisualOrder([
      run('Total:', { x: 10, y: 80, width: 28 }),
      run('GIMEL', { x: 44, y: 80, width: 20, dir: 'rtl' }),
      run('DALET', { x: 70, y: 80, width: 20, dir: 'rtl' }),
    ], pageViewport)

    expect(text).toBe('Total: DALET GIMEL')
  })

  it('keeps text whose geometry is malformed', () => {
    const text = textInVisualOrder([
      run('Hello', { x: 10, y: 80, width: 30 }),
      {
        str: 'kept',
        transform: [Number.NaN, 0, 0, Number.NaN, Number.NaN, Number.POSITIVE_INFINITY],
        width: Number.NaN,
        dir: 'ltr',
      },
    ], pageViewport)

    expect(text).toContain('Hello')
    expect(text).toContain('kept')
  })

  it('keeps one copy of a run drawn twice at the same position', () => {
    const text = textInVisualOrder([
      run('36', { x: 66, y: 80, width: 9.72, fontSize: 8 }),
      run('36', { x: 66, y: 80, width: 9.72, fontSize: 8 }),
      run('Financial Stability Report', { x: 90, y: 80, width: 120, fontSize: 8 }),
    ], pageViewport)

    expect(text).toBe('36 Financial Stability Report')
  })

  it('joins a small-caps seam despite coincidental column alignment', () => {
    const text = textInVisualOrder([
      run('a', { x: 233.59, y: 80, width: 5.6 }),
      run('pril 2020. The data', { x: 239.29, y: 80, width: 90 }),
      run('b', { x: 239.04, y: 60, width: 6.2 }),
      run('b', { x: 239.03, y: 40, width: 6.2 }),
    ], pageViewport)

    expect(text).toBe('april 2020. The data\nb\nb')
  })

  it('returns an empty string when the page has no visible text', () => {
    expect(textInVisualOrder([], pageViewport)).toBe('')
    expect(textInVisualOrder([run(' ', { x: 10, y: 80, width: 5 })], pageViewport)).toBe('')
  })
})
