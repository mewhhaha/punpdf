// Regenerates the hand-rolled text-layout fixtures in test/fixtures.
// Run with: node scripts/generate-text-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures')

// Text must stay free of the characters ( ) \ that would need escaping in
// PDF string literals.
function pdfFromRuns(runs, {
  additionalPages = [],
  mediaBox = [0, 0, 595, 842],
  rotate = 0,
} = {}) {
  const pages = [runs, ...additionalPages]
  const pageReferences = pages.map((_, pageIndex) => 3 + pageIndex * 2)
  const fontReference = 3 + pages.length * 2
  const rotation = rotate ? ` /Rotate ${rotate}` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.map(reference => `${reference} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  for (const [pageIndex, pageRuns] of pages.entries()) {
    const content = pageRuns
      .map(({ text, x, y, size, tm }) => {
        const matrix = tm ?? [1, 0, 0, 1, x, y]
        return `BT /F1 ${size} Tf ${matrix.join(' ')} Tm (${text}) Tj ET`
      })
      .join('\n')
    const contentReference = pageReferences[pageIndex] + 1
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}]${rotation} /Resources << /Font << /F1 ${fontReference} 0 R >> >> /Contents ${contentReference} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

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

const continuationSource = [
  { text: 'Legal and Other Contingencies', x: 57, y: 800, size: 14 },
  { text: 'Category', x: 57, y: 760, size: 9 },
  { text: 'Current', x: 300, y: 760, size: 9 },
  { text: 'Prior', x: 450, y: 760, size: 9 },
  { text: 'Claims', x: 57, y: 740, size: 9 },
  { text: '120', x: 300, y: 740, size: 9 },
  { text: '90', x: 450, y: 740, size: 9 },
]
const independentStatement = [
  { text: 'Example Corp', x: 57, y: 810, size: 10 },
  { text: 'CONSOLIDATED STATEMENTS OF OPERATIONS', x: 57, y: 790, size: 12 },
  { text: 'Category', x: 57, y: 750, size: 9 },
  { text: 'Current', x: 300, y: 750, size: 9 },
  { text: 'Prior', x: 450, y: 750, size: 9 },
  { text: 'Net sales', x: 57, y: 730, size: 9 },
  { text: '390', x: 300, y: 730, size: 9 },
  { text: '380', x: 450, y: 730, size: 9 },
]
writeFileSync(join(fixturesDir, 'independent-table-pages.pdf'), pdfFromRuns(
  continuationSource,
  { additionalPages: [independentStatement] },
))
console.log('wrote test/fixtures/independent-table-pages.pdf')

const previousTableHeader = [
  { text: 'Legacy Statement', x: 40, y: 810, size: 14 },
  { text: 'Legacy category', x: 40, y: 760, size: 8 },
  { text: 'Legacy current', x: 200, y: 760, size: 8 },
  { text: 'Legacy prior', x: 340, y: 760, size: 8 },
  { text: 'Legacy total', x: 480, y: 760, size: 8 },
  { text: 'Prior row', x: 40, y: 740, size: 8 },
  { text: '10', x: 200, y: 740, size: 8 },
  { text: '20', x: 340, y: 740, size: 8 },
  { text: '30', x: 480, y: 740, size: 8 },
]
const locallyCaptionedTable = [
  { text: 'Table 11b. Local assets and liabilities', x: 40, y: 810, size: 10 },
  { text: 'Cash', x: 40, y: 760, size: 8 },
  { text: '100', x: 200, y: 760, size: 8 },
  { text: '200', x: 340, y: 760, size: 8 },
  { text: '300', x: 480, y: 760, size: 8 },
  { text: 'Loans', x: 40, y: 740, size: 8 },
  { text: '400', x: 200, y: 740, size: 8 },
  { text: '500', x: 340, y: 740, size: 8 },
  { text: '600', x: 480, y: 740, size: 8 },
]
writeFileSync(join(fixturesDir, 'local-table-caption.pdf'), pdfFromRuns(
  previousTableHeader,
  { additionalPages: [locallyCaptionedTable] },
))
console.log('wrote test/fixtures/local-table-caption.pdf')

const lowercaseTableCaption = [
  { text: 'Notes to Financial Statements', x: 57, y: 810, size: 10 },
  { text: 'reporting date using', x: 180, y: 770, size: 8 },
  { text: 'Level 1', x: 180, y: 750, size: 8 },
  { text: 'Level 2', x: 300, y: 750, size: 8 },
  { text: 'Total', x: 450, y: 750, size: 8 },
  { text: 'Cash equivalents', x: 57, y: 730, size: 8 },
  { text: '100', x: 180, y: 730, size: 8 },
  { text: '200', x: 300, y: 730, size: 8 },
  { text: '300', x: 450, y: 730, size: 8 },
  { text: 'Marketable securities', x: 57, y: 710, size: 8 },
  { text: '400', x: 180, y: 710, size: 8 },
  { text: '500', x: 300, y: 710, size: 8 },
  { text: '900', x: 450, y: 710, size: 8 },
]
writeFileSync(
  join(fixturesDir, 'lowercase-table-caption.pdf'),
  pdfFromRuns(lowercaseTableCaption),
)
console.log('wrote test/fixtures/lowercase-table-caption.pdf')

const continuedFooter = [
  { text: 'Notes to Financial Statements', x: 57, y: 800, size: 12 },
  { text: 'Narrative content remains part of the note.', x: 57, y: 760, size: 9 },
  { text: '9', x: 57, y: 40, size: 8 },
  { text: 'Continued', x: 500, y: 40, size: 8 },
]
writeFileSync(join(fixturesDir, 'continued-footer.pdf'), pdfFromRuns(continuedFooter))
console.log('wrote test/fixtures/continued-footer.pdf')

const legalSections = [
  { text: 'TERMS AND CONDITIONS', x: 57, y: 800, size: 14 },
  { text: '5. Dividend and Voting Rights.', x: 57, y: 760, size: 10 },
  { text: 'The participant has the rights described in this section.', x: 57, y: 742, size: 9 },
  { text: '6. Restrictions on Transfer.', x: 57, y: 710, size: 10 },
  { text: 'The award may not be assigned or transferred.', x: 57, y: 692, size: 9 },
  { text: '7. Timing and Manner of Settlement.', x: 57, y: 660, size: 10 },
  { text: 'The company will settle vested units after vesting.', x: 57, y: 642, size: 9 },
]
writeFileSync(join(fixturesDir, 'legal-sections.pdf'), pdfFromRuns(legalSections))
console.log('wrote test/fixtures/legal-sections.pdf')

const fragmentedRows = [
  ['Interest', 'income', 'Treasury', 'securities', '$', '10', '$', '20', '$', '30'],
  ['Interest', 'expense', 'Depository', 'institutions', '$', '4', '$', '5', '$', '6'],
  ['Net', 'income', 'before', 'distributions', '$', '6', '$', '15', '$', '24'],
]
const fragmentedFinancialTable = [
  { text: 'Combined Statement of Operations', x: 40, y: 810, size: 14 },
  { text: 'Current', x: 380, y: 780, size: 8 },
  { text: 'Prior', x: 460, y: 780, size: 8 },
  { text: 'Total', x: 540, y: 780, size: 8 },
  ...fragmentedRows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 85, 130, 185, 360, 380, 440, 460, 520, 540][columnIndex],
    y: 750 - rowIndex * 22,
    size: 8,
  }))),
]
writeFileSync(
  join(fixturesDir, 'fragmented-financial-table.pdf'),
  pdfFromRuns(fragmentedFinancialTable),
)
console.log('wrote test/fixtures/fragmented-financial-table.pdf')

const wrappedSummary = [
  { text: 'Net sales:', x: 20, y: 330, size: 8 },
  { text: 'U.S.', x: 35, y: 310, size: 8 },
  { text: '$', x: 363, y: 310, size: 8 },
  { text: '142,196', x: 403, y: 310, size: 8 },
  { text: '$', x: 442, y: 310, size: 8 },
  { text: '138,573', x: 482, y: 310, size: 8 },
  { text: '$', x: 521, y: 310, size: 8 },
  { text: '147,859', x: 561, y: 310, size: 8 },
  { text: 'China', x: 35, y: 299, size: 8 },
  { text: '66,952', x: 407, y: 299, size: 8 },
  { text: '72,559', x: 486, y: 299, size: 8 },
  { text: '74,200', x: 566, y: 299, size: 8 },
  { text: 'Other countries', x: 35, y: 288, size: 8 },
  { text: '181,887', x: 403, y: 288, size: 8 },
  { text: '172,153', x: 482, y: 288, size: 8 },
  { text: '172,269', x: 561, y: 288, size: 8 },
  { text: 'Total net sales', x: 52, y: 277, size: 8 },
  { text: '$', x: 363, y: 277, size: 8 },
  { text: '391,035', x: 403, y: 277, size: 8 },
  { text: '$', x: 442, y: 277, size: 8 },
  { text: '383,285', x: 482, y: 277, size: 8 },
  { text: '$', x: 521, y: 277, size: 8 },
  { text: '394,328', x: 561, y: 277, size: 8 },
  { text: '2024', x: 462, y: 253, size: 7 },
  { text: '2023', x: 547, y: 253, size: 7 },
  { text: 'Long-lived assets:', x: 20, y: 241, size: 8 },
  { text: 'U.S.', x: 35, y: 230, size: 8 },
  { text: '$', x: 432, y: 230, size: 8 },
  { text: '35,664', x: 481, y: 230, size: 8 },
  { text: '$', x: 516, y: 230, size: 8 },
  { text: '33,276', x: 566, y: 230, size: 8 },
]
writeFileSync(join(fixturesDir, 'wrapped-summary.pdf'), pdfFromRuns(wrappedSummary))
console.log('wrote test/fixtures/wrapped-summary.pdf')

const scheduleRows = [
  ['1st', 'December 1', '24 hours after public disclosure of first-quarter results'],
  ['2nd', 'March 1', '24 hours after public disclosure of second-quarter results'],
  ['3rd', 'June 1', '24 hours after public disclosure of third-quarter results'],
  ['4th', 'September 1', '24 hours after public disclosure of year-end results'],
]
const compactSchedule = [
  { text: 'Restricted Trading Periods and Trading Windows', x: 40, y: 800, size: 14 },
  { text: 'Fiscal Quarter', x: 40, y: 750, size: 8 },
  { text: 'Trading Restrictions Begin', x: 150, y: 750, size: 8 },
  { text: 'Trading Restrictions End and Trading Window Opens', x: 300, y: 750, size: 8 },
  ...scheduleRows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [50, 155, 300][columnIndex],
    y: 720 - rowIndex * 30 + (columnIndex === 2 ? 4 : 0),
    size: 8,
  }))),
]
writeFileSync(join(fixturesDir, 'compact-schedule.pdf'), pdfFromRuns(compactSchedule))
console.log('wrote test/fixtures/compact-schedule.pdf')

const detachedFinancialLabels = [
  'Cash',
  'Level 1',
  'Money market funds',
  'Mutual funds',
  'Level 2',
  'Treasury securities',
  'Agency securities',
  'Government securities',
]
const detachedFinancialTable = [
  { text: 'Financial Instruments', x: 40, y: 810, size: 14 },
  ...detachedFinancialLabels.map((text, rowIndex) => ({
    text,
    x: 40,
    y: 770 - rowIndex * 16,
    size: 8,
  })),
  { text: 'Adjusted cost', x: 200, y: 620, size: 8 },
  { text: 'Fair value', x: 320, y: 620, size: 8 },
  { text: 'Current', x: 440, y: 620, size: 8 },
  ...detachedFinancialLabels.flatMap((_, rowIndex) => {
    const rowBaseline = 600 - rowIndex * 16
    const amount = String((rowIndex + 1) * 100)
    return [
      { text: amount, x: 200, y: rowBaseline, size: 8 },
      { text: amount, x: 320, y: rowBaseline, size: 8 },
      { text: amount, x: 440, y: rowBaseline, size: 8 },
    ]
  }),
]
writeFileSync(
  join(fixturesDir, 'detached-financial-labels.pdf'),
  pdfFromRuns(detachedFinancialTable),
)
console.log('wrote test/fixtures/detached-financial-labels.pdf')

const detachedExhibitIdentifiers = Array.from({ length: 7 }, (_, identifierIndex) => ({
  text: `4.${10 + identifierIndex}`,
  x: 40,
  y: 760 - identifierIndex * 18,
  size: 8,
}))
const fragmentedExhibitTable = [
  { text: 'Exhibit Index', x: 40, y: 810, size: 14 },
  { text: 'Exhibit Description', x: 180, y: 790, size: 8 },
  { text: 'Form', x: 400, y: 790, size: 8 },
  { text: 'Date', x: 500, y: 790, size: 8 },
  ...detachedExhibitIdentifiers.flatMap((identifier, rowIndex) => [
    identifier,
    { text: 'Officer Certificate', x: 180, y: identifier.y + 6, size: 8 },
    { text: '8-K 4.1', x: 400, y: identifier.y + 6, size: 8 },
    { text: `2/${23 + rowIndex}/16`, x: 500, y: identifier.y + 6, size: 8 },
  ]),
]
writeFileSync(
  join(fixturesDir, 'detached-exhibit-identifiers.pdf'),
  pdfFromRuns(fragmentedExhibitTable),
)
console.log('wrote test/fixtures/detached-exhibit-identifiers.pdf')

const fragmentedSignatures = [
  { text: 'SIGNATURES', x: 40, y: 810, size: 14 },
  { text: '/s/ Alex Example', x: 40, y: 760, size: 8 },
  { text: 'Chief Executive Officer', x: 250, y: 760, size: 8 },
  { text: 'November 1 2024', x: 450, y: 760, size: 8 },
  { text: '/s/ Blair Example', x: 40, y: 730, size: 8 },
  { text: 'Chief Financial Officer', x: 250, y: 730, size: 8 },
  { text: 'November 1 2024', x: 450, y: 730, size: 8 },
  { text: '/s/ Casey Example', x: 40, y: 700, size: 8 },
  { text: 'Director', x: 250, y: 700, size: 8 },
  { text: 'November 1 2024', x: 450, y: 700, size: 8 },
]
writeFileSync(join(fixturesDir, 'fragmented-signatures.pdf'), pdfFromRuns(fragmentedSignatures))
console.log('wrote test/fixtures/fragmented-signatures.pdf')

const detachedBullets = [
  { text: 'Permitted Transactions', x: 40, y: 810, size: 14 },
  { text: '*', x: 40, y: 760, size: 8 },
  { text: 'Purchases under the employee stock plan are permitted', x: 80, y: 760, size: 8 },
  { text: '*', x: 40, y: 730, size: 8 },
  { text: 'Cash settled option exercises are permitted', x: 80, y: 730, size: 8 },
  { text: '*', x: 40, y: 700, size: 8 },
  { text: 'Approved charitable gifts are permitted', x: 80, y: 700, size: 8 },
]
writeFileSync(join(fixturesDir, 'detached-bullets.pdf'), pdfFromRuns(detachedBullets))
console.log('wrote test/fixtures/detached-bullets.pdf')

const calendarYearContinuation = [
  { text: 'Treasury Remittances', x: 40, y: 810, size: 14 },
  { text: 'The Reserve Banks suspended weekly remittances during 2023 and the first half of', x: 40, y: 770, size: 8 },
  { text: '2024. At June 30 2024 remittances remained suspended.', x: 40, y: 750, size: 8 },
]
writeFileSync(
  join(fixturesDir, 'calendar-year-continuation.pdf'),
  pdfFromRuns(calendarYearContinuation),
)
console.log('wrote test/fixtures/calendar-year-continuation.pdf')

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

// A page number drawn twice at the same position, as layered or faux-bold
// PDFs do. The duplicate draws are separated in the content stream, the way
// layer duplication produces them.
const shadowText = [
  { text: '36', x: 66, y: 780, size: 8 },
  { text: 'Financial Stability Report', x: 90, y: 780, size: 8 },
  { text: '36', x: 66, y: 780, size: 8 },
]
writeFileSync(join(fixturesDir, 'shadow-text.pdf'), pdfFromRuns(shadowText))
console.log('wrote test/fixtures/shadow-text.pdf')

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
