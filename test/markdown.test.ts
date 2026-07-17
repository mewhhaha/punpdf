import type { VisualOrderItem } from '../src/visual-order'
import { describe, expect, it } from 'vitest'
import { markdownFromBlocks } from '../src/markdown'
import { blocksInVisualOrder } from '../src/visual-order'

// An unrotated 100pt-tall page: PDF coordinates are bottom-up, so the
// viewport flips the y axis to make y grow downward.
const pageViewport = [1, 0, 0, -1, 0, 100]

function run(
  str: string,
  position: { x: number, y: number, width: number, fontSize?: number },
): VisualOrderItem {
  const { x, y, width, fontSize = 10 } = position
  return { str, transform: [fontSize, 0, 0, fontSize, x, y], width, dir: 'ltr' }
}

describe('blocksInVisualOrder', () => {
  it('classifies headings, paragraphs, and tables', () => {
    const blocks = blocksInVisualOrder([
      run('Title', { x: 10, y: 95, width: 40, fontSize: 16 }),
      run('Body first line', { x: 10, y: 80, width: 80 }),
      run('Body second line', { x: 10, y: 66, width: 80 }),
      run('CellA', { x: 10, y: 40, width: 25 }),
      run('CellB', { x: 100, y: 40, width: 25 }),
      run('CellC', { x: 10, y: 26, width: 25 }),
      run('CellD', { x: 100, y: 26, width: 25 }),
    ], pageViewport)

    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', lines: ['Body first line', 'Body second line'] },
      { kind: 'table', rows: [['CellA', 'CellB'], ['CellC', 'CellD']] },
    ])
  })

  it('ranks heading levels by their size tier on the page', () => {
    const blocks = blocksInVisualOrder([
      run('Chapter', { x: 10, y: 95, width: 50, fontSize: 18 }),
      run('Section', { x: 10, y: 60, width: 50, fontSize: 14 }),
      run('Body text here', { x: 10, y: 30, width: 80 }),
      run('and more body', { x: 10, y: 16, width: 80 }),
    ], pageViewport)

    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Chapter' },
      { kind: 'heading', level: 2, text: 'Section' },
      { kind: 'paragraph', lines: ['Body text here', 'and more body'] },
    ])
  })
})

describe('markdownFromBlocks', () => {
  it('renders headings, paragraphs, and escaped tables', () => {
    const markdown = markdownFromBlocks([
      { kind: 'heading', level: 2, text: 'Results' },
      { kind: 'paragraph', lines: ['one', 'two'] },
      { kind: 'table', rows: [['Item', 'Qty'], ['Nails | screws', '12']] },
    ])

    expect(markdown).toBe(
      '## Results\n'
      + '\n'
      + 'one\n'
      + 'two\n'
      + '\n'
      + '| Item | Qty |\n'
      + '| --- | --- |\n'
      + '| Nails \\| screws | 12 |',
    )
  })

  it('pads ragged table rows to the widest row', () => {
    const markdown = markdownFromBlocks([
      { kind: 'table', rows: [['a', 'b', 'c'], ['d']] },
    ])

    expect(markdown).toBe(
      '| a | b | c |\n'
      + '| --- | --- | --- |\n'
      + '| d |  |  |',
    )
  })
})
