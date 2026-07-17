import type { TextBlock } from './visual-order'

/**
 * Renders structural text blocks as GitHub-flavored Markdown. Tables use
 * their first row as the header row, since PDF tables carry no header
 * markup of their own.
 */
export function markdownFromBlocks(blocks: TextBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === 'heading') {
        return `${'#'.repeat(block.level)} ${block.text}`
      }
      if (block.kind === 'table') {
        return markdownTable(block.rows)
      }
      return block.lines.join('\n')
    })
    .join('\n\n')
}

function markdownTable(rows: string[][]): string {
  const columnCount = Math.max(...rows.map(row => row.length))
  const renderRow = (row: string[]) => {
    const cells = Array.from(
      { length: columnCount },
      (_, columnIndex) => (row[columnIndex] ?? '').trim().replaceAll('|', '\\|'),
    )
    return `| ${cells.join(' | ')} |`
  }

  const [header, ...body] = rows
  if (!header) {
    return ''
  }
  return [
    renderRow(header),
    `|${' --- |'.repeat(columnCount)}`,
    ...body.map(row => renderRow(row)),
  ].join('\n')
}
