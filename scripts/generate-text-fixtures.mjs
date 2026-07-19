// Regenerates the hand-rolled text-layout fixtures in test/fixtures.
// Run with: node scripts/generate-text-fixtures.mjs
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultFixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures')
const fixturesDir = process.argv[2] ? resolve(process.argv[2]) : defaultFixturesDir
mkdirSync(fixturesDir, { recursive: true })

function pdfFromRuns(runs, {
  additionalPages = [],
  fontEncoding,
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
      .map(({ text, pdfLiteral, x, y, size, tm }) => {
        if (pdfLiteral === undefined && /[^\x20-\x7E]/.test(text)) {
          throw new Error(`PDF fixture text "${text}" requires an encoded pdfLiteral`)
        }
        const matrix = tm ?? [1, 0, 0, 1, x, y]
        const encodedText = pdfLiteral ?? text
          .replaceAll('\\', '\\\\')
          .replaceAll('(', '\\(')
          .replaceAll(')', '\\)')
          .replaceAll('\r', '\\r')
          .replaceAll('\n', '\\n')
        return `BT /F1 ${size} Tf ${matrix.join(' ')} Tm (${encodedText}) Tj ET`
      })
      .join('\n')
    const contentReference = pageReferences[pageIndex] + 1
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}]${rotation} /Resources << /Font << /F1 ${fontReference} 0 R >> >> /Contents ${contentReference} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
  }
  const encoding = fontEncoding ? ` /Encoding /${fontEncoding}` : ''
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${encoding} >>`)

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
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

const escapedPdfLiterals = [
  { text: 'Fixture literals', x: 57, y: 780, size: 14 },
  { text: 'Forecast (draft)', x: 57, y: 740, size: 10 },
  { text: 'Archive \\ Reports', x: 57, y: 720, size: 10 },
]

for (const [filename, runs] of [
  ['two-column.pdf', twoColumn],
  ['table.pdf', table],
  ['superscript.pdf', superscript],
  ['escaped-pdf-literals.pdf', escapedPdfLiterals],
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

const detachedFinancialTableHeader = [
  { text: 'Statement of position', x: 40, y: 810, size: 14 },
  { text: 'Note', x: 280, y: 770, size: 8 },
  { text: 'Current', x: 380, y: 770, size: 8 },
  { text: 'Prior', x: 480, y: 770, size: 8 },
  { text: 'Assets', x: 40, y: 750, size: 8 },
  { text: 'Cash', x: 40, y: 730, size: 8 },
  { text: '3', x: 280, y: 730, size: 8 },
  { text: '120', x: 380, y: 730, size: 8 },
  { text: '110', x: 480, y: 730, size: 8 },
  { text: 'Investments', x: 40, y: 710, size: 8 },
  { text: '4', x: 280, y: 710, size: 8 },
  { text: '240', x: 380, y: 710, size: 8 },
  { text: '220', x: 480, y: 710, size: 8 },
]
const stackedDetachedFinancialTableHeader = [
  { text: 'Asset rollforward', x: 40, y: 810, size: 14 },
  { text: 'Operating assets', x: 280, y: 780, size: 8 },
  { text: 'Total assets', x: 480, y: 780, size: 8 },
  { text: 'Cash', x: 280, y: 764, size: 8 },
  { text: 'Securities', x: 380, y: 764, size: 8 },
  { text: 'Total', x: 480, y: 764, size: 8 },
  { text: 'Cost', x: 40, y: 740, size: 8 },
  { text: 'Opening balance', x: 40, y: 720, size: 8 },
  { text: '120', x: 280, y: 720, size: 8 },
  { text: '240', x: 380, y: 720, size: 8 },
  { text: '360', x: 480, y: 720, size: 8 },
  { text: 'Closing balance', x: 40, y: 700, size: 8 },
  { text: '130', x: 280, y: 700, size: 8 },
  { text: '260', x: 380, y: 700, size: 8 },
  { text: '390', x: 480, y: 700, size: 8 },
]
const firstFinancialRecordAfterHeader = [
  { text: 'Swap facilities', x: 40, y: 810, size: 14 },
  { text: 'As at year end', x: 40, y: 780, size: 8 },
  { text: 'Currency', x: 260, y: 780, size: 8 },
  { text: 'Expiry', x: 380, y: 780, size: 8 },
  { text: 'Limit', x: 500, y: 780, size: 8 },
  { text: 'Standing', x: 40, y: 750, size: 8 },
  { text: 'facilities', x: 78, y: 750, size: 8 },
  { text: 'with partner banks', x: 40, y: 734, size: 8 },
  { text: 'Central Bank A', x: 40, y: 714, size: 8 },
  { text: 'Dollars', x: 260, y: 714, size: 8 },
  { text: 'No expiry', x: 380, y: 714, size: 8 },
  { text: 'Unlimited', x: 500, y: 714, size: 8 },
  { text: 'Central Bank B', x: 40, y: 694, size: 8 },
  { text: 'Euros', x: 260, y: 694, size: 8 },
  { text: 'Annual', x: 380, y: 694, size: 8 },
  { text: '500', x: 500, y: 694, size: 8 },
]
const independentFinancialTable = [
  { text: 'Valuation notes', x: 40, y: 810, size: 14 },
  { text: 'Opening balance', x: 40, y: 780, size: 8 },
  { text: '100', x: 380, y: 780, size: 8 },
  { text: '90', x: 500, y: 780, size: 8 },
  { text: 'Closing balance', x: 40, y: 760, size: 8 },
  { text: '110', x: 380, y: 760, size: 8 },
  { text: '95', x: 500, y: 760, size: 8 },
  { text: 'Independent valuation schedule', x: 40, y: 730, size: 8 },
  { text: 'Measured at year end', x: 40, y: 714, size: 8 },
  { text: 'Cost', x: 280, y: 690, size: 8 },
  { text: 'Fair value', x: 380, y: 690, size: 8 },
  { text: 'Total', x: 500, y: 690, size: 8 },
  { text: 'Government bonds', x: 40, y: 670, size: 8 },
  { text: '120', x: 280, y: 670, size: 8 },
  { text: '125', x: 380, y: 670, size: 8 },
  { text: '245', x: 500, y: 670, size: 8 },
  { text: 'Corporate bonds', x: 40, y: 650, size: 8 },
  { text: '30', x: 280, y: 650, size: 8 },
  { text: '35', x: 380, y: 650, size: 8 },
  { text: '65', x: 500, y: 650, size: 8 },
]
const headerlessFinancialSection = [
  { text: 'Supplementary schedule', x: 40, y: 810, size: 14 },
  { text: 'North', x: 60.8, y: 720, size: 8 },
  { text: 'America Commercial', x: 82.2, y: 720, size: 8 },
  { text: '$', x: 184.3, y: 720, size: 8 },
  { text: '8,172', x: 224.6, y: 720, size: 8 },
  { text: '$', x: 252.5, y: 720, size: 8 },
  { text: '(b)', x: 296, y: 723, size: 6 },
  { text: '$', x: 320.8, y: 720, size: 8 },
  { text: '5,713', x: 355.8, y: 720, size: 8 },
  { text: '$', x: 383.8, y: 720, size: 8 },
  { text: '824', x: 431.5, y: 720, size: 8 },
  { text: '$', x: 452.8, y: 720, size: 8 },
  { text: '1,087', x: 493.1, y: 720, size: 8 },
  { text: '$', x: 521, y: 720, size: 8 },
  { text: '8,452', x: 561.3, y: 720, size: 8 },
  { text: 'International Commercial', x: 60.8, y: 700, size: 8 },
  { text: '8,145', x: 224.6, y: 700, size: 8 },
  { text: '(b)', x: 296, y: 703, size: 6 },
  { text: '4,463', x: 355.8, y: 700, size: 8 },
  { text: '1,018', x: 431.5, y: 700, size: 8 },
  { text: '1,437', x: 493.1, y: 700, size: 8 },
  { text: '8,364', x: 561.3, y: 700, size: 8 },
  { text: 'Global Personal', x: 60.8, y: 680, size: 8 },
  { text: '7,140', x: 224.6, y: 680, size: 8 },
  { text: '(b)', x: 296, y: 683, size: 6 },
  { text: '3,862', x: 355.8, y: 680, size: 8 },
  { text: '1,571', x: 431.5, y: 680, size: 8 },
  { text: '1,565', x: 493.1, y: 680, size: 8 },
  { text: '7,086', x: 561.3, y: 680, size: 8 },
]
const wrappedFinancialRowLabel = [
  { text: 'Indemnity balance', x: 40, y: 810, size: 14 },
  { text: 'Opening balance', x: 40, y: 780, size: 8 },
  { text: '100', x: 380, y: 780, size: 8 },
  { text: '90', x: 500, y: 780, size: 8 },
  { text: 'Movement', x: 40, y: 760, size: 8 },
  { text: '20', x: 380, y: 760, size: 8 },
  { text: '15', x: 500, y: 760, size: 8 },
  { text: 'Closing balance', x: 40, y: 730, size: 8 },
  { text: 'as at', x: 102, y: 730, size: 8 },
  { text: '31', x: 40, y: 710, size: 8 },
  { text: 'December', x: 120, y: 710, size: 8 },
  { text: '120', x: 380, y: 710, size: 8 },
  { text: '105', x: 500, y: 710, size: 8 },
]
writeFileSync(
  join(fixturesDir, 'detached-financial-table-header.pdf'),
  pdfFromRuns(detachedFinancialTableHeader, {
    additionalPages: [stackedDetachedFinancialTableHeader],
  }),
)
console.log('wrote test/fixtures/detached-financial-table-header.pdf')
writeFileSync(
  join(fixturesDir, 'financial-record-after-header.pdf'),
  pdfFromRuns(firstFinancialRecordAfterHeader),
)
console.log('wrote test/fixtures/financial-record-after-header.pdf')
writeFileSync(
  join(fixturesDir, 'independent-financial-table.pdf'),
  pdfFromRuns(independentFinancialTable),
)
console.log('wrote test/fixtures/independent-financial-table.pdf')
writeFileSync(
  join(fixturesDir, 'headerless-financial-section.pdf'),
  pdfFromRuns(headerlessFinancialSection),
)
console.log('wrote test/fixtures/headerless-financial-section.pdf')
writeFileSync(
  join(fixturesDir, 'wrapped-financial-row.pdf'),
  pdfFromRuns(wrappedFinancialRowLabel),
)
console.log('wrote test/fixtures/wrapped-financial-row.pdf')

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

const alignedNarrativeColumns = [
  { text: 'Operations Overview', x: 40, y: 810, size: 14 },
  ...[
    'The left column begins with the operating mandate',
    'and explains how the insurance fund is administered',
    'before describing the sources available for funding',
    'when ordinary assessments cannot cover the shortfall',
    'The final left paragraph completes its own argument.',
  ].flatMap((text, lineIndex) => [
    { text, x: 40, y: 770 - lineIndex * 16, size: 8 },
  ]),
  ...[
    'The right column begins an independent policy section',
    'and explains how investments must remain available',
    'before describing the limits placed on borrowing',
    'when extraordinary liquidity support is necessary',
    'The final right paragraph completes a separate argument.',
  ].flatMap((text, lineIndex) => [
    { text, x: 310, y: 770 - lineIndex * 16, size: 8 },
  ]),
]
writeFileSync(
  join(fixturesDir, 'aligned-narrative-columns.pdf'),
  pdfFromRuns(alignedNarrativeColumns),
)
console.log('wrote test/fixtures/aligned-narrative-columns.pdf')

const narrativeGridAfterTable = [
  { text: 'Service Overview', x: 40, y: 810, size: 14 },
  { text: 'Locations', x: 40, y: 770, size: 8 },
  { text: '58', x: 300, y: 770, size: 8 },
  { text: '55', x: 450, y: 770, size: 8 },
  { text: 'Customers', x: 40, y: 750, size: 8 },
  { text: '41', x: 300, y: 750, size: 8 },
  { text: '39', x: 450, y: 750, size: 8 },
  { text: 'Details', x: 40, y: 710, size: 8 },
  ...[
    ['Regional reach', 'Teams serve customers across several markets'],
    ['Core services', 'Specialists support local business requirements'],
    ['Delivery model', 'Four groups coordinate the operating programme'],
  ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 240][columnIndex],
    y: 680 - rowIndex * 16,
    size: 8,
  }))),
  { text: 'The programme continues in the following section.', x: 40, y: 610, size: 8 },
]
const narrativeGridAfterLabels = [
  { text: 'Account Overview', x: 40, y: 810, size: 14 },
  { text: 'Accounts', x: 40, y: 770, size: 8 },
  { text: '24', x: 300, y: 770, size: 8 },
  { text: '22', x: 450, y: 770, size: 8 },
  { text: 'Details', x: 40, y: 710, size: 8 },
  { text: 'Overview', x: 40, y: 694, size: 8 },
  { text: 'Service scope', x: 40, y: 660, size: 8 },
  { text: 'Advisers cover commercial accounts', x: 240, y: 660, size: 8 },
  { text: 'Review cycle', x: 40, y: 644, size: 8 },
  { text: 'Teams report progress every quarter', x: 240, y: 644, size: 8 },
]
writeFileSync(
  join(fixturesDir, 'narrative-grid-after-table.pdf'),
  pdfFromRuns(narrativeGridAfterTable, {
    additionalPages: [narrativeGridAfterLabels],
  }),
)
console.log('wrote test/fixtures/narrative-grid-after-table.pdf')

const fragmentedParallelNarrative = [
  { text: 'Parallel Narrative Report', x: 40, y: 810, size: 14 },
  ...[
    ['The first left paragraph introduces operating policy', 'The first right paragraph introduces funding policy'],
    ['The left discussion continues through its second line', 'The right discussion continues through its second line'],
    ['The left discussion closes its opening paragraph here', 'The right discussion closes its opening paragraph here'],
  ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 310][columnIndex],
    y: 770 - rowIndex * 14,
    size: 8,
  }))),
  { text: 'Operating policy continued', x: 40, y: 720, size: 9 },
  ...[
    ['A second left paragraph describes the claims process', 'A second right paragraph describes liquidity sources'],
    ['Its left explanation remains independent and complete', 'Its right explanation remains independent and complete'],
    ['The second left paragraph ends before the next section', 'The second right paragraph ends before the next section'],
  ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 310][columnIndex],
    y: 700 - rowIndex * 14,
    size: 8,
  }))),
  { text: 'Liquidity policy continued', x: 310, y: 650, size: 9 },
  ...[
    ['The final left section explains annual assessments', 'The final right section explains emergency borrowing'],
    ['Each left sentence belongs to the operating narrative', 'Each right sentence belongs to the funding narrative'],
    ['Both columns finish without becoming table records', 'Both policy discussions finish on their own terms'],
  ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 310][columnIndex],
    y: 630 - rowIndex * 14,
    size: 8,
  }))),
]
writeFileSync(
  join(fixturesDir, 'fragmented-parallel-narrative.pdf'),
  pdfFromRuns(fragmentedParallelNarrative),
)
console.log('wrote test/fixtures/fragmented-parallel-narrative.pdf')

const repeatedNavigation = [
  { text: 'Overview', x: 40, y: 820, size: 7 },
  { text: 'Operations', x: 160, y: 820, size: 7 },
  { text: 'Financial statements', x: 300, y: 820, size: 7 },
  { text: 'Appendices', x: 480, y: 820, size: 7 },
  { text: 'Example Foundation Annual Report 2024', x: 40, y: 804, size: 7 },
]
const repeatedNavigationBodyRows = [
  ['The left report column begins its annual discussion', 'The right report column begins its policy discussion'],
  ['The annual discussion continues with operating context', 'The policy discussion continues with funding context'],
  ['The first report sections close before their transitions', 'The first policy sections close before their transitions'],
  ['The second left section describes current priorities', 'The second right section describes current risks'],
  ['Each priority remains within the left report column', 'Each risk remains within the right report column'],
  ['Both second sections conclude before the final pair', 'Both policy sections conclude before the final pair'],
  ['The final left section records the annual outcome', 'The final right section records the policy outcome'],
  ['The annual outcome remains complete in its column', 'The policy outcome remains complete in its column'],
  ['The report columns finish without creating table records', 'The policy columns finish without creating table records'],
]
function repeatedNavigationPage(pageNumber, heading, paragraph) {
  return [
    ...repeatedNavigation,
    { text: String(pageNumber), x: 530, y: 804, size: 7 },
    { text: heading, x: 40, y: 760, size: 14 },
    { text: paragraph, x: 40, y: 730, size: 9 },
    ...repeatedNavigationBodyRows.slice(0, 3).flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => ({
        text,
        x: [40, 310][columnIndex],
        y: 700 - rowIndex * 14,
        size: 8,
      }))),
    { text: 'Annual discussion continued', x: 40, y: 640, size: 9 },
    ...repeatedNavigationBodyRows.slice(3, 6).flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => ({
        text,
        x: [40, 310][columnIndex],
        y: 620 - rowIndex * 14,
        size: 8,
      }))),
    { text: 'Policy discussion continued', x: 310, y: 560, size: 9 },
    ...repeatedNavigationBodyRows.slice(6).flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => ({
        text,
        x: [40, 310][columnIndex],
        y: 540 - rowIndex * 14,
        size: 8,
      }))),
  ]
}
writeFileSync(
  join(fixturesDir, 'repeated-page-navigation.pdf'),
  pdfFromRuns(
    repeatedNavigationPage(1, 'Chair report', 'The chair describes the work completed during the year.'),
    {
      additionalPages: [
        repeatedNavigationPage(2, 'Financial review', 'The review explains the financial result for the year.'),
        repeatedNavigationPage(3, 'Funding appendix', 'The appendix identifies the principal funding sources.'),
      ],
    },
  ),
)
console.log('wrote test/fixtures/repeated-page-navigation.pdf')

const tableWithSidebarRows = [
  ['Name', 'Position', 'Organisation', 'Term ends'],
  ['Alex North', 'Controller', 'Example One', '30 June 2026'],
  ['Blair West', 'Finance Director', 'Example Two', '30 June 2027'],
  ['Casey South', 'Audit Partner', 'Example Three', '30 June 2025'],
  ['Devon East', 'Reporting Director', 'Example Four', '30 June 2026'],
  ['Emery Lake', 'Technical Director', 'Example Five', '30 June 2027'],
]
const sidebarLines = [
  'Observer organisations',
  'Banking Supervision Committee',
  'Securities Commission',
  'Market Conduct Council',
]
const tableWithSidebar = [
  { text: 'Interpretations Committee', x: 40, y: 560, size: 14 },
  ...tableWithSidebarRows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    text,
    x: [40, 180, 310, 430][columnIndex],
    y: 520 - rowIndex * 24,
    size: 8,
  }))),
  ...sidebarLines.map((text, lineIndex) => ({
    text,
    x: 650,
    y: 520 - lineIndex * 24,
    size: 8,
  })),
]
writeFileSync(
  join(fixturesDir, 'table-with-sidebar.pdf'),
  pdfFromRuns(tableWithSidebar, { mediaBox: [0, 0, 842, 595] }),
)
console.log('wrote test/fixtures/table-with-sidebar.pdf')

const misdecodedCheckmarks = [
  { text: 'Compensation Practices', x: 40, y: 810, size: 14 },
  { text: 'What We Do', x: 40, y: 770, size: 9 },
  { text: 'What We Do Not Do', x: 310, y: 770, size: 9 },
  ...[
    ['Use measurable performance goals', 'Promise automatic payouts'],
    ['Review compensation risk annually', 'Provide tax gross ups'],
    ['Maintain an independent adviser', 'Permit unearned dividends'],
  ].flatMap((row, rowIndex) => [
    { text: 'ü', pdfLiteral: '\\374', x: 40, y: 740 - rowIndex * 28, size: 9 },
    { text: row[0], x: 60, y: 740 - rowIndex * 28, size: 9 },
    { text: 'X', x: 310, y: 740 - rowIndex * 28, size: 9 },
    { text: row[1], x: 330, y: 740 - rowIndex * 28, size: 9 },
  ]),
]
writeFileSync(
  join(fixturesDir, 'misdecoded-checkmarks.pdf'),
  pdfFromRuns(misdecodedCheckmarks, { fontEncoding: 'WinAnsiEncoding' }),
)
console.log('wrote test/fixtures/misdecoded-checkmarks.pdf')

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
