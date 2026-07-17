// Regenerates the hand-rolled text-layout fixtures in test/fixtures.
// Run with: node scripts/generate-text-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures')

// Text must stay free of the characters ( ) \ that would need escaping in
// PDF string literals.
function pdfFromRuns(runs, { mediaBox = [0, 0, 595, 842], rotate = 0 } = {}) {
  const content = runs
    .map(({ text, x, y, size, tm }) => {
      const matrix = tm ?? [1, 0, 0, 1, x, y]
      return `BT /F1 ${size} Tf ${matrix.join(' ')} Tm (${text}) Tj ET`
    })
    .join('\n')
  const rotation = rotate ? ` /Rotate ${rotate}` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}]${rotation} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return pdf
}

const leftColumnLines = [
  'The left column begins the story',
  'and continues along its own flow',
  'of narrow measured lines that fill',
  'the first of the two columns.',
]
const rightColumnLines = [
  'The right column tells another',
  'story entirely and must not be',
  'interleaved with the left column',
  'when read in visual order.',
]
const twoColumn = [
  { text: 'Two Column Sample', x: 57, y: 780, size: 16 },
  ...leftColumnLines.map((text, line) => ({ text, x: 57, y: 740 - line * 14, size: 10 })),
  ...rightColumnLines.map((text, line) => ({ text, x: 311, y: 733 - line * 14, size: 10 })),
]

const tableRows = [
  ['Item', 'Qty', 'Price'],
  ['Demolition', '2', '450.00'],
  ['Framing', '5', '1200.00'],
  ['Painting', '3', '300.00'],
]
const table = [
  { text: 'Invoice', x: 57, y: 790, size: 14 },
  ...tableRows.flatMap(([item, quantity, price], row) => [
    { text: item, x: 57, y: 750 - row * 16, size: 10 },
    { text: quantity, x: 300, y: 750 - row * 16, size: 10 },
    { text: price, x: 450, y: 750 - row * 16, size: 10 },
  ]),
]

const superscript = [
  { text: 'E=mc', x: 57, y: 700, size: 12 },
  { text: '2', x: 88.2, y: 704, size: 8 },
  { text: 'H', x: 57, y: 670, size: 12 },
  { text: '2', x: 65.8, y: 667.2, size: 8 },
  { text: 'O', x: 70.3, y: 670, size: 12 },
]

for (const [filename, runs] of [
  ['two-column.pdf', twoColumn],
  ['table.pdf', table],
  ['superscript.pdf', superscript],
]) {
  writeFileSync(join(fixturesDir, filename), pdfFromRuns(runs))
  console.log(`wrote test/fixtures/${filename}`)
}

// Row-vector convention: apply m, then n.
function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

function invert(m) {
  const determinant = m[0] * m[3] - m[1] * m[2]
  const a = m[3] / determinant
  const b = -m[1] / determinant
  const c = -m[2] / determinant
  const d = m[0] / determinant
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

// PDF.js viewport transform for a page at scale 1 (display origin top-left).
function viewportFor(rotate, [, , width, height]) {
  switch (rotate) {
    case 90:
      return [0, 1, 1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, 1, width, 0]
    case 270:
      return [0, -1, -1, 0, height, width]
    default:
      return [1, 0, 0, -1, 0, height]
  }
}

// The mixed-layout memo is laid out in display coordinates (origin top-left,
// y growing downward) on an 842x595 landscape page, then authored through
// the inverse viewport of each rotation so every rotated variant renders
// identically and must read identically.
const memoLeftColumn = [
  'Alpha reports strong',
  'engagement in the north',
  'while retention holds',
  'above expectations.',
]
const memoRightColumn = [
  'Beta launches next',
  'quarter with pricing',
  'still under internal',
  'review by finance.',
]
const memoAmounts = [['North', '120.00'], ['South', '98.50'], ['East', '210.75']]
const memo = [
  { text: 'Quarterly Review', x: 57, y: 60, size: 16 },
  { text: 'Revenue grew steadily across all regions', x: 57, y: 100, size: 10 },
  { text: 'with costs held flat for the quarter.', x: 57, y: 114, size: 10 },
  ...memoAmounts.flatMap(([region, amount], row) => [
    { text: region, x: 57, y: 160 + row * 16, size: 10 },
    { text: amount, x: 400 - amount.length * 5, y: 160 + row * 16, size: 10 },
  ]),
  ...memoLeftColumn.map((text, line) => ({ text, x: 57, y: 240 + line * 14, size: 10 })),
  ...memoRightColumn.map((text, line) => ({ text, x: 450, y: 247 + line * 14, size: 10 })),
  { text: 'Page 1 of 1', x: 700, y: 560, size: 8 },
]

// A sideways table on an unrotated portrait page, as financial reports
// embed landscape tables and chart labels: the text advances up the page
// (transform [0, s, -s, 0, x, y]) while the page itself stays upright.
const sidewaysRows = [
  ['$1,947', '$1,930', '$1,842'],
  ['$2,006', '$1,999', '$1,921'],
  ['$2.31', '$2.23', '$2.18'],
]
const sidewaysTable = [
  { text: 'Portfolio Summary', x: 57, y: 780, size: 14 },
  ...sidewaysRows.flatMap((row, rowIndex) => row.map((cell, columnIndex) => ({
    text: cell,
    size: 8,
    tm: [0, 1, -1, 0, 200 + rowIndex * 16, 500 + columnIndex * 60],
  }))),
]
writeFileSync(join(fixturesDir, 'sideways-table.pdf'), pdfFromRuns(sidewaysTable))
console.log('wrote test/fixtures/sideways-table.pdf')

for (const rotate of [0, 90, 180, 270]) {
  const mediaBox = rotate % 180 === 0 ? [0, 0, 842, 595] : [0, 0, 595, 842]
  const inverseViewport = invert(viewportFor(rotate, mediaBox))
  const runs = memo.map(({ text, x, y, size }) => {
    const authored = multiply([size, 0, 0, -size, x, y], inverseViewport)
    return {
      text,
      size,
      tm: [
        authored[0] / size,
        authored[1] / size,
        authored[2] / size,
        authored[3] / size,
        authored[4],
        authored[5],
      ].map(value => Math.round(value * 10000) / 10000),
    }
  })
  const filename = rotate === 0 ? 'mixed-layout.pdf' : `mixed-layout-rotate${rotate}.pdf`
  writeFileSync(join(fixturesDir, filename), pdfFromRuns(runs, { mediaBox, rotate }))
  console.log(`wrote test/fixtures/${filename}`)
}
