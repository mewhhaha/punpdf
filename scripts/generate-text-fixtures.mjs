// Regenerates the hand-rolled text-layout fixtures in test/fixtures.
// Run with: node scripts/generate-text-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures')

// Text must stay free of the characters ( ) \ that would need escaping in
// PDF string literals.
function pdfFromRuns(runs) {
  const content = runs
    .map(({ text, x, y, size }) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`)
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
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
