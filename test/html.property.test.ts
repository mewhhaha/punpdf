/* eslint-disable ts/ban-ts-comment */
import { beforeAll, describe, expect, it } from 'vitest'
import { definePDFJSModule, extractHTML } from '../src/index'

beforeAll(async () => {
  // @ts-ignore: Dynamic import from package build
  await definePDFJSModule(() => import('../dist/pdfjs'))
})

interface AuthoredRun {
  text: string
  x: number
  y: number
  size: number
  matrix?: [number, number, number, number, number, number]
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function authorPdf(
  runs: AuthoredRun[],
  additionalPages: AuthoredRun[][] = [],
  pageCommands: string[] = [],
): Uint8Array {
  const pages = [runs, ...additionalPages]
  const fontReference = 3 + pages.length * 2
  const pageReferences = pages.map((_, index) => 3 + index * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.map(reference => `${reference} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  for (const [pageIndex, pageRuns] of pages.entries()) {
    const content = pageRuns
      .map(({ text, x, y, size, matrix }) =>
        `BT /F1 ${size} Tf ${(matrix ?? [1, 0, 0, 1, x, y]).join(' ')} Tm (${escapePdfString(text)}) Tj ET`)
      .concat(pageCommands[pageIndex] ?? '')
      .join('\n')
    const contentReference = pageReferences[pageIndex]! + 1
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontReference} 0 R >> >> /Contents ${contentReference} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

function tableRuns(
  rows: string[][],
  options: { size?: number, starts?: number[], top?: number } = {},
): AuthoredRun[] {
  const { size = 4, starts = rows[0]!.map((_, index) => 100 + index * 18), top = 780 } = options
  return rows.flatMap((row, rowIndex) => row.flatMap((text, columnIndex) =>
    text.length === 0
      ? []
      : [{ text, x: starts[columnIndex]!, y: top - rowIndex * size * 1.5, size }]))
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function htmlRows(document: string): string[] {
  return [...document.matchAll(/<tr(?:\s[^>]*)?>(.*?)<\/tr>/gs)].map(match => match[0])
}

function htmlCells(row: string): string[] {
  return [...row.matchAll(/<t[hd](?:\s[^>]*)?>(.*?)<\/t[hd]>/gs)]
    .map(match => htmlText(match[1]!))
}

function htmlText(fragment: string): string {
  return fragment
    .replaceAll('<br>', '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
}

describe('html extraction properties', () => {
  it('keeps narrow columns distinct in wide financial tables', async () => {
    const headers = Array.from({ length: 12 }, (_, index) => `M${String.fromCharCode(65 + index)}`)
    const rows = Array.from({ length: 8 }, (_, rowIndex) =>
      headers.map((_, columnIndex) => String((rowIndex + 1) * 100 + columnIndex)))
    const { html } = await extractHTML(authorPdf(tableRuns([headers, ...rows])))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows[0]!)).toEqual(headers)
    for (const [rowIndex, expected] of rows.entries()) {
      expect(htmlCells(renderedRows[rowIndex + 1]!), `row ${rowIndex + 1}`)
        .toEqual(expected)
    }
  })

  it('uses a wide record as the schema when detail rows are sparse', async () => {
    const headers = [
      'Unit',
      'Floorplan',
      'Unit Designation',
      'SQFT',
      'Status',
      'Name',
      'Move In',
      'Lease Start',
      'Lease End',
      'Market',
      'Code',
      'Lease Rent',
      'Other Charges',
      'Total Billing',
      'Deposit',
      'Balance',
    ]
    const rows = [
      ['101', 'A1', 'N/A', '750', 'Occupied', 'Resident One', '01/01/2025', '01/01/2025', '12/31/2025', '1,700.00', 'RENT', '1,700.00', '0.00', '1,700.00', '400.00', '0.00'],
      ['', '', '', '', '', 'Resident,', '', '', '', '', 'TRASH', '0.00 *', '15.00 *', '', '', ''],
      ['', '', '', '', '', 'One', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', 'Resident One', '', '', '', '', 'PEST', '0.00 *', '6.00 *', '', '', ''],
      ['', '', '', '', '', 'Resident One', '', '', '', '', 'INTERNET', '0.00 *', '72.00 *', '', '', ''],
      ['', '', '', '', '', 'Resident Two', '', '', '', '', 'TRASH', '0.00 *', '15.00 *', '', '', ''],
      ['', '', '', '', '', 'Resident Two', '', '', '', '', 'PEST', '0.00 *', '6.00 *', '', '', ''],
      ['', '', '', '', '', 'Resident Two', '', '', '', '', 'INTERNET', '0.00 *', '72.00 *', '', '', ''],
    ]
    const { html } = await extractHTML(authorPdf([
      { text: 'Rent Roll Detail', x: 50, y: 820, size: 12 },
      ...tableRuns([headers, ...rows], {
        size: 2.5,
        starts: [15, 48, 83, 120, 145, 190, 255, 290, 325, 360, 395, 430, 465, 500, 535, 570],
        top: 790,
      }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual(headers)
    expect(renderedRows).toContainEqual(rows[0])
    expect(renderedRows).toContainEqual([
      '',
      '',
      '',
      '',
      '',
      'Resident,\nOne',
      '',
      '',
      '',
      '',
      'TRASH',
      '0.00 *',
      '15.00 *',
      '',
      '',
      '',
    ])
    expect(renderedRows).toContainEqual(rows[5])
  })

  it('keeps sparse subrows aligned across varying table widths', async () => {
    for (let seed = 25; seed <= 40; seed++) {
      const random = mulberry32(seed)
      const columnCount = 6 + Math.floor(random() * 15)
      const headers = Array.from({ length: columnCount }, (_, index) => `C${index}`)
      const primaryRecord = headers.map((_, index) => String(1000 + seed * 100 + index))
      const sparseColumns = [Math.floor(columnCount / 2), columnCount - 2, columnCount - 1]
      const sparseRecord = Array.from<string>({ length: columnCount }).fill('')
      sparseRecord[sparseColumns[0]!] = 'Wrapped,'
      sparseRecord[sparseColumns[1]!] = '0.00 *'
      sparseRecord[sparseColumns[2]!] = '15.00 *'
      const continuation = Array.from<string>({ length: columnCount }).fill('')
      continuation[sparseColumns[0]!] = 'Label'
      const followingRecords = Array.from({ length: 5 }, (_, rowIndex) => {
        const record = Array.from<string>({ length: columnCount }).fill('')
        record[sparseColumns[0]!] = `Detail ${rowIndex + 1}`
        record[sparseColumns[1]!] = '0.00 *'
        record[sparseColumns[2]!] = `${rowIndex + 1}.00 *`
        return record
      })
      const starts = headers.map((_, index) =>
        20 + index * (550 / (columnCount - 1)))
      const { html } = await extractHTML(authorPdf(tableRuns([
        headers,
        primaryRecord,
        sparseRecord,
        continuation,
        ...followingRecords,
      ], {
        size: 2.5,
        starts,
        top: 800,
      })))
      const renderedRows = htmlRows(html[0]!).map(htmlCells)
      const expectedSparseRecord = [...sparseRecord]
      expectedSparseRecord[sparseColumns[0]!] = 'Wrapped,\nLabel'

      expect(html[0]!.match(/<table>/g), `seed ${seed}`).toHaveLength(1)
      expect(renderedRows, `seed ${seed}`).toContainEqual(primaryRecord)
      expect(renderedRows, `seed ${seed}`).toContainEqual(expectedSparseRecord)
    }
  })

  it('combines stacked headers without a fixed depth limit', async () => {
    const columnCount = 8
    const starts = Array.from({ length: columnCount }, (_, index) => 30 + index * 65)
    for (let headerDepth = 2; headerDepth <= 9; headerDepth++) {
      const headerRows = Array.from({ length: headerDepth }, (_, rowIndex) => {
        const header = Array.from<string>({ length: columnCount }).fill('')
        if (rowIndex === 0) {
          header[1] = 'Left Group'
          header[6] = 'Right Group'
        }
        else if (rowIndex === headerDepth - 1) {
          for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
            header[columnIndex] = `Field ${columnIndex + 1}`
          }
        }
        else {
          header[1 + rowIndex % (columnCount - 1)] = `Layer ${rowIndex}`
        }
        return header
      })
      const records = Array.from({ length: 3 }, (_, rowIndex) =>
        Array.from({ length: columnCount }, (_, columnIndex) =>
          String((rowIndex + 1) * 100 + columnIndex)))
      const { html } = await extractHTML(authorPdf(tableRuns(
        [...headerRows, ...records],
        { size: 3, starts, top: 810 },
      )))
      const expectedHeader = Array.from({ length: columnCount }, (_, columnIndex) =>
        headerRows.map(row => row[columnIndex]!).filter(Boolean).join('\n'))

      expect(htmlRows(html[0]!).map(htmlCells), `depth ${headerDepth}`)
        .toContainEqual(expectedHeader)
    }
  })

  it('combines sparse wrapped labels in wide table headers', async () => {
    const starts = [20, 75, 130, 185, 250, 320, 385, 450, 510, 565]
    const topHeader = ['', '', '', '', '', 'Market', 'Other', '', '', '']
    const headerRows = [
      ['Unit', 'Floorplan', 'Unit/Lease', 'Name', 'Move-In', '+ Addl.', '', 'Lease', 'Dep', 'balance'],
      ['', '', '', '', '', '', 'Charges/', '', '', ''],
      ['', '', 'Status', '', 'Move-Out', '', '', 'Rent', 'On Hand', ''],
      ['', '', '', '', '', '', 'Credits', '', '', ''],
    ]
    const records = [
      ['101', 'A1', 'Occupied', 'Resident One', '01/01/2025', '1,700.00', 'RENT', '1,700.00', '400.00', '0.00'],
      ['102', 'B1', 'Occupied', 'Resident Two', '02/01/2025', '2,100.00', 'RENT', '2,100.00', '500.00', '0.00'],
      ['103', 'C1', 'Occupied', 'Resident Three', '03/01/2025', '2,300.00', 'RENT', '2,300.00', '600.00', '0.00'],
    ]
    const { html } = await extractHTML(authorPdf([
      ...tableRuns([topHeader], { size: 3.5, starts, top: 790 }),
      ...tableRuns([...headerRows, ...records], { size: 3, starts, top: 780 }),
    ]))
    const [renderedHeader] = htmlRows(html[0]!).map(htmlCells)

    expect(renderedHeader).toEqual([
      'Unit',
      'Floorplan',
      'Unit/Lease\nStatus',
      'Name',
      'Move-In\nMove-Out',
      'Market\n+ Addl.',
      'Other\nCharges/\nCredits',
      'Lease\nRent',
      'Dep\nOn Hand',
      'balance',
    ])
  })

  it('preserves an empty column when separate header labels surround it', async () => {
    const headerY = 790
    const starts = [36, 90.84, 288, 378, 549.84]
    const rows = [
      ['04/27/26', 'Settlement one', '', '906614023443950', '6,820.00'],
      ['04/28/26', 'Settlement two', '', '906617040717595', '4,305.40'],
      ['04/29/26', 'Settlement three', '', '906618030170541', '12,725.44'],
    ]
    const { html } = await extractHTML(authorPdf([
      { text: 'Date', x: starts[0]!, y: headerY, size: 8 },
      { text: 'Transaction description', x: starts[1]!, y: headerY, size: 8 },
      { text: 'Customer reference', x: starts[2]!, y: headerY, size: 8 },
      { text: 'Bank reference', x: starts[3]!, y: headerY, size: 8 },
      { text: 'Amount', x: starts[4]!, y: headerY, size: 8 },
      ...tableRuns(rows, { starts, top: 770, size: 8 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      'Date',
      'Transaction description',
      'Customer reference',
      'Bank reference',
      'Amount',
    ])
    for (const row of rows) {
      expect(renderedRows).toContainEqual(row)
    }
  })

  it('keeps separately positioned text runs in one wide table column', async () => {
    const headerY = 790
    const rows = [
      ['04/28/26', 'RealPage', 'DES:EDI PYMNTS ID:3114242', '906617040703565', '-21,713.17'],
      ['04/29/26', 'GS DEPOSITORY', 'DES:CORP COLL ID:NMALLHIG', '906618021978062', '-21,218.89'],
      ['05/04/26', 'BT PAYMODE-X', 'DES:PAYMENT', '902321008815716', '-9,153.18'],
    ]
    const runs = rows.flatMap((row, rowIndex) => {
      const y = 770 - rowIndex * 24
      return [
        { text: row[0]!, x: 36, y, size: 9 },
        { text: row[1]!, x: 90.84, y, size: 9 },
        { text: row[2]!, x: 147.84, y, size: 9 },
        { text: row[3]!, x: 378, y, size: 9 },
        { text: row[4]!, x: 534.48, y, size: 9 },
      ]
    })
    const { html } = await extractHTML(authorPdf([
      { text: 'Date', x: 36, y: headerY, size: 8 },
      { text: 'Transaction description', x: 90.84, y: headerY, size: 8 },
      { text: 'Customer reference', x: 288, y: headerY, size: 8 },
      { text: 'Bank reference', x: 378, y: headerY, size: 8 },
      { text: 'Amount', x: 549.84, y: headerY, size: 8 },
      ...runs,
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      'Date',
      'Transaction description',
      'Customer reference',
      'Bank reference',
      'Amount',
    ])
    for (const row of rows) {
      expect(renderedRows).toContainEqual([
        row[0]!,
        `${row[1]} ${row[2]}`,
        '',
        row[3]!,
        row[4]!,
      ])
    }
  })

  it('separates packed trailing labels and keeps the opening record out of the header', async () => {
    const starts = [20, 72, 135, 180, 220, 310, 355, 405, 445, 485, 535]
    const rows = [
      ['Property', 'Property Name', 'Date', 'Period', 'Description', 'Control', 'Reference', 'Debit', 'Credit', '', 'Balance Remarks'],
      ['11020-000', '', '', '', 'Cash - Operating', '', '', '', '', '', '234,079.29 = Beginning Balance ='],
      ['property', 'Property Name', '04/27/2026', '05/2026', 'Vendor', 'J-100', 'Reference', '0.00', '206.95', '233,872.34 Imported 04/27/2026', ''],
      ['property', 'Property Name', '04/30/2026', '05/2026', 'Vendor', 'K-200', '850', '0.00', '16.14', '189,574.30 U:3003:', 'Replace emitters'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 3,
      starts,
      top: 800,
    })))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      'Property',
      'Property Name',
      'Date',
      'Period',
      'Description',
      'Control',
      'Reference',
      'Debit',
      'Credit',
      'Balance',
      'Remarks',
    ])
    expect(renderedRows.find(row => row[0] === '11020-000')).toBeDefined()
    expect(renderedRows[0]![0]).toBe('Property')
    expect(renderedRows).toContainEqual([
      'property',
      'Property Name',
      '04/27/2026',
      '05/2026',
      'Vendor',
      'J-100',
      'Reference',
      '0.00',
      '206.95',
      '233,872.34',
      'Imported 04/27/2026',
    ])
    expect(renderedRows).toContainEqual([
      'property',
      'Property Name',
      '04/30/2026',
      '05/2026',
      'Vendor',
      'K-200',
      '850',
      '0.00',
      '16.14',
      '189,574.30',
      'U:3003: Replace emitters',
    ])
  })

  it('attaches wrapped table text and a trailing labeled total', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Deposits', x: 36, y: 825, size: 15 },
      { text: 'Date', x: 36, y: 800, size: 8 },
      { text: 'Transaction description', x: 90.84, y: 800, size: 8 },
      { text: 'Customer reference', x: 288, y: 800, size: 8 },
      { text: 'Bank reference', x: 378, y: 800, size: 8 },
      { text: 'Amount', x: 549.84, y: 800, size: 8 },
      { text: '04/30/26', x: 36, y: 780, size: 9 },
      { text: 'WIRE TYPE:BOOK IN', x: 90.84, y: 780, size: 9 },
      { text: '903704300522882', x: 378, y: 780, size: 9 },
      { text: '2,300.00', x: 542.64, y: 780, size: 9 },
      { text: 'TRN:2026043000522882 SNDR', x: 90.84, y: 769.2, size: 9 },
      { text: 'REF:C1KBKT000036 ORIG:PROPERTY', x: 90.84, y: 758.4, size: 9 },
      { text: 'Total deposits', x: 36, y: 739, size: 10 },
      { text: '$2,300.00', x: 529.68, y: 739, size: 10 },
      { text: 'Daily balances', x: 36, y: 700, size: 15 },
      { text: 'Date', x: 36, y: 680, size: 8 },
      { text: 'Balance ($)', x: 167.88, y: 680, size: 8 },
      { text: 'Date', x: 221.4, y: 680, size: 8 },
      { text: 'Balance($)', x: 355.44, y: 680, size: 8 },
      { text: '04/26', x: 36, y: 660, size: 9.5 },
      { text: '125,398.70', x: 159.96, y: 660, size: 9.5 },
      { text: '04/30', x: 221.4, y: 660, size: 9.5 },
      { text: '127,698.70', x: 345.36, y: 660, size: 9.5 },
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      '04/30/26',
      'WIRE TYPE:BOOK IN\nTRN:2026043000522882 SNDR\nREF:C1KBKT000036 ORIG:PROPERTY',
      '',
      '903704300522882',
      '2,300.00',
    ])
    expect(renderedRows).toContainEqual(['Total deposits', '', '', '', '$2,300.00'])
    expect(renderedRows).toContainEqual(['04/26', '125,398.70'])
    expect(renderedRows).toContainEqual(['04/30', '127,698.70'])
    expect(html[0]).not.toContain('<p>Total deposits')
    expect(html[0]).toContain('<div class="parallel-tables" style="--parallel-count: 2">')
    expect(html[0]!.match(/<table>/g)).toHaveLength(3)
  })

  it('preserves empty cells in sparse wide tables', async () => {
    const rows = [
      ['Name', 'Jan', 'Feb', 'Mar', 'Apr', 'May'],
      ['Alpha', '10', '', '30', '', '50'],
      ['Beta', '', '20', '', '40', ''],
      ['Total', '10', '20', '30', '40', '50'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows)))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows[1]!)).toEqual(rows[1])
    expect(htmlCells(renderedRows[2]!)).toEqual(rows[2])
  })

  it('uses one column for right-aligned values with different widths', async () => {
    const headers = ['Name', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Total']
    const rows = [
      ['Alpha', '0.00', '20.00', '3,000.00', '400.00', '5.00', '3,425.00'],
      ['Beta', '10,000.00', '2.00', '300.00', '4,000.00', '50.00', '14,352.00'],
      ['Total', '10,000.00', '22.00', '3,300.00', '4,400.00', '55.00', '17,777.00'],
    ]
    const rightEdges = [0, 190, 250, 310, 370, 430, 490]
    const runs = [
      ...tableRuns([headers], {
        starts: [50, 165, 225, 285, 345, 405, 465],
      }),
      ...rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
        text,
        x: columnIndex === 0
          ? 50
          : rightEdges[columnIndex]! - text.length * 2.25,
        y: 774 - rowIndex * 6,
        size: 4,
      }))),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows[0]!)).toEqual(headers)
    for (const [rowIndex, expected] of rows.entries()) {
      expect(htmlCells(renderedRows[rowIndex + 1]!), `row ${rowIndex + 1}`)
        .toEqual(expected)
    }
    expect(renderedRows.at(-1)).toContain('class="summary"')
  })

  it('joins wrapped decimal suffixes to their preceding cells', async () => {
    const rows = [
      ['Name', 'Current', 'Projected', 'Budget'],
      ['Alpha', '100.00', '4,686,827.', '4,689,528.'],
      ['', '', '', '10 00'],
      ['Beta', '200.00', '300.00', '400.00'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 5,
      starts: [50, 180, 310, 430],
    })))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows[1]!)).toEqual([
      'Alpha',
      '100.00',
      '4,686,827.10',
      '4,689,528.00',
    ])
    expect(renderedRows).toHaveLength(3)
  })

  it('keeps compact rating columns distinct', async () => {
    const rows = [
      ['Area', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
      ['Kitchens', '7/10', '7/10', '7/10', '8/10', '7/10', '7/10', '8/10', '8/10', '9/10'],
      ['Bathrooms', '-', '6/10', '7/10', '8/10', '8/10', '7/10', '7/10', '7/10', '8/10'],
    ]
    const starts = [40, 180, 192, 204, 216, 228, 240, 252, 264, 276]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 4,
      starts,
    })))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows[1]!)).toEqual(rows[1])
    expect(htmlCells(renderedRows[2]!)).toEqual(rows[2])
  })

  it('renders spanning section labels as headings with repeated columns', async () => {
    const rows = [
      ['Month', 'January', 'February', 'March'],
      ['Closing (%)', '40%', '23%', '14%'],
      ['', '', 'Renewal Activity', ''],
      ['Renewal (%)', '42%', '43%', '53%'],
    ]
    const table = tableRuns(rows, {
      size: 5,
      starts: [50, 200, 300, 400],
      top: 780,
    }).map(run => run.text === 'Renewal Activity' ? { ...run, size: 8 } : run)
    const { html } = await extractHTML(authorPdf([
      { text: 'Portfolio Activity', x: 230, y: 792, size: 8 },
      ...table,
    ]))

    expect(html[0]).toContain('<h1>Portfolio Activity</h1>')
    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(html[0]).toContain('<tr class="section"><th colspan="4" scope="rowgroup">Renewal Activity</th></tr>')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual(['Renewal (%)', '42%', '43%', '53%'])
  })

  it('expands packed calendar labels and keeps year-to-date values in the final column', async () => {
    const rows = [
      ['Month', 'January', 'February', 'March', 'April', 'May June July August', 'September October November December YTD'],
      ['Shows / Traffic (#)', '25', '26', '42', '62', '44', '199'],
      ['Closing (%)', '40%', '23%', '14%', '34%', '48% #DIV/0! #DIV/0! #DIV/0! #DIV/0!', '#DIV/0! #DIV/0! #DIV/0! 32%'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 4,
      starts: [30, 130, 185, 240, 295, 350, 455],
    })))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows[0]).toEqual([
      'Month',
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
      'YTD',
    ])
    expect(renderedRows[1]!.at(-1)).toBe('199')
    expect(renderedRows[2]!.at(-1)).toBe('32%')
  })

  it('promotes a detached multirow header and preserves its column groups', async () => {
    const starts = [50, 115, 190, 255, 330, 395, 465, 525]
    const runs = [
      ...tableRuns([
        ['Floor Plan', 'Floor', 'Total', 'No Lease', 'Lease', 'Total', 'No NTV', 'Occupancy'],
        ['Group', 'Plan Units', 'Vacant', 'Application', 'Applications', 'Occupied', 'NTV', 'Percent'],
      ], { size: 4, starts, top: 800 }),
      { text: '1-1', x: 30, y: 775, size: 5 },
      ...tableRuns([
        ['', 'A1 34', '3', '0', '3', '31', '29', '91.18'],
      ], { size: 4, starts, top: 765 }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(html[0]).toContain('<thead>')
    expect(html[0]).toContain('<th colspan="3" scope="colgroup">Vacant</th>')
    expect(html[0]).toContain('<th colspan="2" scope="colgroup">Occupied</th>')
    expect(html[0]).toContain('<tr class="section"><th colspan="8" scope="rowgroup">1-1</th></tr>')
  })

  it('removes a detached label strip when the following table preserves the same groups', async () => {
    const groupLabels = ['Rent comparison', 'Current rents', 'Prior rents', 'Historical rents']
    const groupStarts = [30, 165, 300, 435]
    const starts = [30, 95, 165, 230, 300, 365, 435, 500]
    const { html } = await extractHTML(authorPdf([
      ...tableRuns([
        groupLabels,
        ['Report date: 6/15/2026', '', '', ''],
      ], { size: 4, starts: groupStarts, top: 830 }),
      ...tableRuns([
        ['Total', '', 'Total', '', 'Total', '', 'Total', ''],
        ['Rent comparison', 'Units', 'Current rents', 'Value', 'Prior rents', 'Value', 'Historical rents', 'Value'],
        ['Subject', '281', '$1,700', '$1,900', '$1,690', '$1,890', '$1,680', '$1,880'],
        ['Average', '245', '$1,600', '$1,800', '$1,590', '$1,790', '$1,580', '$1,780'],
        ['Competitor', '250', '$1,500', '$1,700', '$1,490', '$1,690', '$1,480', '$1,680'],
      ], { size: 2, starts, top: 805 }),
    ]))

    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(html[0]).toContain('<p>Report date: 6/15/2026</p>')
    expect(html[0]).toContain('<th colspan="2" scope="colgroup">Rent comparison</th>')
    expect(html[0]).toContain('<th colspan="2" scope="colgroup">Current rents</th>')
    expect(html[0]).toContain('<th colspan="2" scope="colgroup">Prior rents</th>')
    expect(html[0]).toContain('<th colspan="2" scope="colgroup">Historical rents</th>')
  })

  it('structures three stable indentation levels without changing their labels or values', async () => {
    const metricHeaders = ['Floor', 'Sqft', 'Rent', 'Effective Rent', 'Rent PSF', 'Effective PSF', 'Concession', 'Days', 'Leases']
    const metricStarts = [160, 205, 250, 305, 370, 420, 470, 515, 555]
    const records: Array<{ label: string, level: number, values: string[] }> = []
    let recordIndex = 0
    const nextMetricValues = () => {
      recordIndex++
      return [
        String(recordIndex % 3 + 1),
        String(800 + recordIndex),
        `$${1_500 + recordIndex}`,
        `$${1_450 + recordIndex}`,
        `$${(1.5 + recordIndex / 100).toFixed(2)}`,
        `$${(1.4 + recordIndex / 100).toFixed(2)}`,
        `${recordIndex}.0%`,
        String(40 + recordIndex),
        String(10 + recordIndex),
      ]
    }
    for (let propertyIndex = 1; propertyIndex <= 2; propertyIndex++) {
      records.push({ label: `Property ${propertyIndex}`, level: 0, values: nextMetricValues() })
      for (let bedroomIndex = 1; bedroomIndex <= 2; bedroomIndex++) {
        records.push({ label: `${bedroomIndex} Bedroom`, level: 1, values: nextMetricValues() })
        for (let planIndex = 1; planIndex <= 4; planIndex++) {
          records.push({
            label: `Plan ${propertyIndex}-${bedroomIndex}-${planIndex}`,
            level: 2,
            values: nextMetricValues(),
          })
        }
      }
    }
    records.push({ label: 'Grand Total', level: 0, values: nextMetricValues() })
    const runs = [
      ...tableRuns([
        ['Floorplan Data', ...metricHeaders],
      ], { size: 3, starts: [30, ...metricStarts], top: 810 }),
      ...records.flatMap((record, rowIndex) => [
        { text: record.label, x: [30, 55, 80][record.level]!, y: 805 - rowIndex * 4, size: 3 },
        ...record.values.map((value, columnIndex) => ({
          text: value,
          x: metricStarts[columnIndex]!,
          y: 805 - rowIndex * 4,
          size: 3,
        })),
      ]),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!)

    expect(html[0]).toContain('<th colspan="3" scope="col">Floorplan Data</th>')
    expect(rows.find(row => htmlCells(row).includes('Property 1'))).toContain('class="group"')
    expect(rows.find(row => htmlCells(row).includes('1 Bedroom'))).toContain('class="subgroup"')
    expect(htmlCells(rows.find(row => htmlCells(row).includes('Property 1'))!).slice(0, 3))
      .toEqual(['Property 1', '', ''])
    expect(htmlCells(rows.find(row => htmlCells(row).includes('1 Bedroom'))!).slice(0, 3))
      .toEqual(['', '1 Bedroom', ''])
    expect(htmlCells(rows.find(row => htmlCells(row).includes('Plan 1-1-1'))!).slice(0, 3))
      .toEqual(['', '', 'Plan 1-1-1'])
    expect(html[0]).toContain('<tfoot>')
    expect(htmlCells(rows.at(-1)!).slice(0, 3)).toEqual(['Grand Total', '', ''])
    expect(htmlText(html[0]!)).not.toContain('All floor plans')
  })

  it('preserves grouped advertising headers and their column annotations', async () => {
    const starts = [
      15,
      49,
      83,
      117,
      151,
      185,
      219,
      253,
      287,
      321,
      355,
      389,
      423,
      457,
      491,
      525,
      559,
    ]
    const headers = [
      'Advertising Source',
      'New Prospects',
      'This Period % of Prospects',
      'Phone Calls',
      'This Period % of Phone Calls',
      'Visits',
      'This Period % of Visits',
      'Visits',
      'Return Visits',
      '** Off-Site Conversions',
      'Lease Applications',
      'Waitlist',
      'Leases Cancelled / Denied',
      'Leases with Waitlist',
      '% of Net',
      'Prospects Converted to Lease Applications',
      'Visits Converted to Lease Applications',
    ]
    const { html } = await extractHTML(authorPdf([
      { text: 'Primary Advertising Source Evaluation', x: 190, y: 830, size: 8 },
      { text: 'i', x: starts[10]!, y: 818, size: 4 },
      { text: '+', x: starts[11]!, y: 818, size: 4 },
      { text: '-', x: starts[12]!, y: 818, size: 4 },
      { text: '=', x: starts[13]!, y: 818, size: 4 },
      { text: '1st Time Contacts', x: 185, y: 810, size: 4 },
      { text: 'Leasing Activity Detail', x: 425, y: 810, size: 4 },
      { text: 'Net', x: starts[13]!, y: 792, size: 4 },
      { text: '***', x: starts[15]!, y: 800, size: 4 },
      { text: '***', x: starts[16]!, y: 800, size: 4 },
      ...tableRuns([
        headers,
        ['Apartment List', '26', '21.85%', '1', '10.00%', '0', '0.00%', '5', '1', '5', '1', '1', '1', '1', '6.25%', '3.85%', '20.00%'],
        ['Totals:', '26', '100.00%', '1', '100.00%', '0', '0.00%', '5', '1', '5', '1', '1', '1', '1', '100.00%', '3.85%', '20.00%'],
      ], { size: 1, starts, top: 785 }),
    ]))

    expect(html[0]).toContain('<th colspan="6" scope="colgroup">1st Time Contacts</th>')
    expect(html[0]).toContain('<th colspan="4" scope="colgroup">Leasing Activity Detail</th>')
    expect(html[0]).toContain('<th scope="col">i<br>Lease Applications</th>')
    expect(html[0]).toContain('<th scope="col">+<br>Waitlist</th>')
    expect(html[0]).toContain('<th scope="col">-<br>Leases Cancelled / Denied</th>')
    expect(html[0]).toContain('<th scope="col">Net<br>=<br>Leases with Waitlist</th>')
    expect(html[0]).toContain('<th scope="col">***<br>Prospects Converted to Lease Applications</th>')
    expect(html[0]).toContain('<th scope="col">***<br>Visits Converted to Lease Applications</th>')
    expect(html[0]).not.toContain('<p>i + - =</p>')
  })

  it('keeps grouped table totals in the first column', async () => {
    const starts = [30, 180, 300, 430]
    const { html } = await extractHTML(authorPdf([
      { text: 'Boxscore', x: 250, y: 825, size: 10 },
      ...tableRuns([
        ['Floor Plan Group', 'Floor Plan', 'Units', 'Move-Ins'],
      ], { size: 5, starts, top: 800 }),
      { text: '1-1', x: starts[0]!, y: 780, size: 5 },
      ...tableRuns([
        ['', 'A1', '18', '2'],
        ['Total 1-1:', '', '18', '2'],
      ], { size: 5, starts, top: 765 }),
    ]))
    const totalRow = htmlRows(html[0]!).map(htmlCells).find(row =>
      row.includes('Total 1-1:'))

    expect(totalRow).toEqual(['Total 1-1:', '', '18', '2'])
  })

  it('uses demographic headers instead of an unrelated inherited schema', async () => {
    const priorPage = [
      { text: 'Lease Expiration Report', x: 190, y: 820, size: 10 },
      ...tableRuns([
        ['Leasing Consultant', 'Captured from month to month', 'Captured this month', 'Captured in the future'],
        ['Example Consultant', '1', '2', '3'],
      ], { size: 4, starts: [30, 170, 330, 470], top: 790 }),
    ]
    const demographicPage = [
      { text: 'Demographic statistics report', x: 190, y: 820, size: 10 },
      { text: 'Age Range:', x: 30, y: 790, size: 7 },
      ...tableRuns([
        ['46 - 49', '31', '3.38%'],
        ['50 - 53', '35', '3.81%'],
        ['Unknown', '17', '1.85%'],
        ['Total', '83', '9.04%'],
      ], { size: 5, starts: [30, 250, 400], top: 770 }),
      { text: '1/2', x: 560, y: 20, size: 5 },
    ]
    const { html } = await extractHTML(authorPdf(priorPage, [demographicPage]))
    const ageRangeHTML = html[1]!.slice(html[1]!.indexOf('<h2>Age Range:</h2>'))

    expect(ageRangeHTML).toContain('<th scope="col">Category</th><th scope="col">Count</th><th scope="col">Percentage</th>')
    expect(ageRangeHTML).not.toContain('Leasing Consultant')
    expect(ageRangeHTML).not.toContain('Captured from')
    expect(ageRangeHTML).not.toContain('>1/2<')
  })

  it('renders adjacent income tables as repeated three-column groups', async () => {
    const starts = [30, 180, 260, 310, 460, 540]
    const { html } = await extractHTML(authorPdf([
      { text: 'Demographic statistics report', x: 190, y: 820, size: 10 },
      ...tableRuns([
        ['Individual income:', '', '', 'Household income:', '', ''],
        ['Below 10,000', '211', '23.19%', 'Below 10,000', '24', '4.42%'],
        ['10,000 - 16,000', '11', '1.21%', '10,000 - 16,000', '2', '0.37%'],
      ], { size: 4, starts, top: 780 }),
    ]))

    expect(html[0]).toContain('<th colspan="3" scope="colgroup">Individual income:</th>')
    expect(html[0]).toContain('<th colspan="3" scope="colgroup">Household income:</th>')
    expect(html[0]).toContain(
      '<th scope="col">Category</th><th scope="col">Count</th><th scope="col">Percentage</th>'
      + '<th scope="col">Category</th><th scope="col">Count</th><th scope="col">Percentage</th>',
    )
  })

  it('keeps report context outside repeated metric column groups', async () => {
    const starts = Array.from({ length: 26 }, (_, columnIndex) => 10 + columnIndex * 22)
    const header = [
      'Property Name',
      'Floorplan Name',
      'Beds',
      'Baths',
      'Half Baths',
      '# Units',
      'Avg Days on Mkt',
      'Sqft',
      'Rent',
      'PSF',
      'NER',
      'NER PSF',
      'Rent',
      'NER',
      '# Leases',
      'Rent',
      'NER',
      '# Leases',
      'Rent',
      'NER',
      '# Leases',
      'Rent',
      'NER',
      'Conc. %',
      'Avg DOM',
      '# Listings',
    ]
    const firstRecord = [
      'Subject Property',
      'A1',
      '1',
      '1',
      '1',
      '18',
      '135',
      '749',
      '$1,664',
      '$2.22',
      '$1,661',
      '$2.22',
      '$1,639',
      '$1,639',
      '6',
      '$1,641',
      '$1,641',
      '4',
      '$1,606',
      '$1,606',
      '2',
      '$1,650',
      '$1,620',
      '1.8%',
      '24',
      '8',
    ]
    const secondRecord = [
      'Comparable Property',
      'A2',
      '2',
      '2',
      '0',
      '24',
      '42',
      '980',
      '$1,900',
      '$1.94',
      '$1,875',
      '$1.91',
      '$1,850',
      '$1,825',
      '3',
      '$1,840',
      '$1,815',
      '2',
      '$1,830',
      '$1,805',
      '1',
      '$1,860',
      '$1,820',
      '2.4%',
      '31',
      '5',
    ]
    const runs = [
      { text: 'Unit Mix - Subject & Comps', x: 10, y: 830, size: 8 },
      { text: 'Note: Leased rents include recent rent-roll observations for the selected period.', x: 10, y: 816, size: 4 },
      { text: 'Metric', x: 400, y: 816, size: 4 },
      { text: 'Chunk Rent', x: 430, y: 816, size: 4 },
      { text: 'Leased Rents (Rent Roll)', x: 190, y: 807, size: 2 },
      { text: '90', x: 274, y: 807, size: 2 },
      { text: 'Day Leased Rents', x: 284, y: 807, size: 2 },
      { text: '60', x: 340, y: 807, size: 2 },
      { text: 'Day Leased Rents', x: 350, y: 807, size: 2 },
      { text: '30', x: 406, y: 807, size: 2 },
      { text: 'Day Leased Rents', x: 416, y: 807, size: 2 },
      { text: 'Active Listings', x: 492, y: 807, size: 2 },
      ...tableRuns([header, firstRecord, secondRecord], { size: 2, starts, top: 800 }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const tableHeader = /<thead>[\s\S]*?<\/thead>/.exec(html[0]!)?.[0]

    expect(html[0]).toContain('<p>Metric: Chunk Rent</p>')
    expect(html[0]).toContain('<p>Note: Leased rents include recent rent-roll observations for the selected period.</p>')
    expect(tableHeader).not.toContain('Note:')
    expect(tableHeader).not.toContain('Metric')
    expect(tableHeader).toContain('<th colspan="4" scope="colgroup">Leased Rents (Rent Roll)</th>')
    expect(tableHeader).toContain('<th colspan="3" scope="colgroup">90 Day Leased Rents</th>')
    expect(tableHeader).toContain('<th colspan="3" scope="colgroup">60 Day Leased Rents</th>')
    expect(tableHeader).toContain('<th colspan="3" scope="colgroup">30 Day Leased Rents</th>')
    expect(tableHeader).toContain('<th colspan="5" scope="colgroup">Active Listings</th>')
  })

  it('keeps an extra numeric column in an independent section', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Measures', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['Category', 'Current', 'Prior'],
        ['Opening', '100', '90'],
      ], { size: 8, starts: [40, 380, 500], top: 780 }),
      { text: 'Breakdown', x: 40, y: 730, size: 8 },
      ...tableRuns([
        ['1', '2', '3', '4'],
        ['5', '6', '7', '8'],
      ], { size: 8, starts: [40, 220, 380, 500], top: 700 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(2)
    expect(renderedRows).toContainEqual(['1', '2', '3', '4'])
    expect(renderedRows).toContainEqual(['5', '6', '7', '8'])
  })

  it('does not use a narrower independent header for a wider table', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Schedules', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['Category', 'Current', 'Prior'],
      ], { size: 8, starts: [40, 380, 500], top: 780 }),
      { text: 'Independent schedule', x: 40, y: 750, size: 8 },
      ...tableRuns([
        ['Bond A', 'Cost', '120', '125'],
        ['Bond B', 'Value', '30', '35'],
      ], { size: 8, starts: [40, 220, 380, 500], top: 720 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(2)
    expect(renderedRows).toContainEqual(['Category', 'Current', 'Prior'])
    expect(renderedRows).toContainEqual(['Bond A', 'Cost', '120', '125'])
  })

  it('keeps a same-width headed schedule independent from a headerless table', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Schedules', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['OVERVIEW', '(EUR million)*', 'FINANCING ACTIVITY'],
      ], { size: 6, starts: [40, 180, 320], top: 780 }),
      { text: '31/12/2025 31/12/2024', x: 300, y: 740, size: 6 },
      ...tableRuns([
        ['Loans disbursed', 'Current', 'Prior'],
        ['100000', '11', '623'],
      ], { size: 6, starts: [40, 260, 430], top: 700 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(2)
    expect(renderedRows).toContainEqual([
      'Loans disbursed',
      'Current',
      'Prior',
    ])
    expect(renderedRows).toContainEqual(['100000', '11', '623'])
  })

  it('keeps headerless text records in the table body', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Facilities', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['Central Bank A', 'Dollars', 'No expiry', 'Unlimited'],
        ['Central Bank B', 'Euros', 'Annual', 'Committed'],
      ], { size: 8, starts: [40, 220, 380, 500], top: 780 }),
      { text: 'Balances', x: 40, y: 730, size: 8 },
      ...tableRuns([
        ['Opening', '10', '20', '30'],
        ['Closing', '15', '25', '35'],
      ], { size: 8, starts: [40, 220, 380, 500], top: 700 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual(['Central Bank A', 'Dollars', 'No expiry', 'Unlimited'])
    expect(renderedRows).toContainEqual(['Central Bank B', 'Euros', 'Annual', 'Committed'])
    expect(html[0]).not.toContain('<th scope="col">Central Bank A<br>Central Bank B</th>')
  })

  it('keeps sparse headerless text records in the table body', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Facilities', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['Central Bank A', 'Dollars', ''],
        ['Central Bank B', 'Euros', 'Committed'],
      ], { size: 8, starts: [40, 280, 440], top: 780 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual(['Central Bank A', 'Dollars', ''])
    expect(renderedRows).toContainEqual(['Central Bank B', 'Euros', 'Committed'])
    expect(html[0]).not.toContain('<thead>')
  })

  it('keeps a long text roster before a numeric footer in the table body', async () => {
    const roster = [
      ['Belgium', 'Minister One', 'Minister of Finance'],
      ['Bulgaria', 'Minister Two', 'Minister of Finance'],
      ['Croatia', 'Minister Three', 'Minister of Finance'],
      ['Estonia', 'Minister Four', 'Minister for Finance'],
      ['Ireland', 'Minister Five', 'Minister for Finance'],
      ['Latvia', 'Minister Six', 'Minister for Finance'],
      ['36', '2025 FINANCIAL REPORT', ''],
    ]
    const { html } = await extractHTML(authorPdf([
      { text: 'Board of Governors', x: 40, y: 820, size: 14 },
      ...tableRuns(roster, { size: 7, starts: [40, 220, 390], top: 790 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual(['Belgium', 'Minister One', 'Minister of Finance'])
    expect(renderedRows).toContainEqual(['Latvia', 'Minister Six', 'Minister for Finance'])
    expect(html[0]).not.toContain('<th scope="col">Belgium<br>Bulgaria')
    expect(html[0]).toContain('36 2025 FINANCIAL REPORT')
  })

  it('keeps report-labelled records inside the table body', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Publications', x: 40, y: 820, size: 14 },
      ...tableRuns([
        ['Research paper A', 'Economics', 'Published'],
        ['Research paper B', 'Monetary policy', 'Published'],
        ['Research paper C', 'Statistics', 'Published'],
        ['Research paper D', 'Markets', 'Published'],
        ['Research paper E', 'Financial stability', 'Published'],
        ['36', '2025 FINANCIAL REPORT', 'Published'],
        ['Monthly bulletin', 'Statistics', 'Published'],
      ], { size: 7, starts: [40, 220, 390], top: 150 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual(['36', '2025 FINANCIAL REPORT', 'Published'])
    expect(renderedRows).toContainEqual(['Monthly bulletin', 'Statistics', 'Published'])
  })

  it('aligns wrapped records after multiple section labels', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: 'Balances', x: 40, y: 810, size: 14 },
      ...tableRuns([
        ['Category', 'Current', 'Prior'],
        ['Opening', '100', '90'],
      ], { size: 8, starts: [40, 380, 500], top: 780 }),
      { text: 'Closing balance as at', x: 40, y: 730, size: 8 },
      { text: 'year end', x: 40, y: 714, size: 8 },
      ...tableRuns([
        ['31', 'December', '120', '105'],
      ], { size: 8, starts: [40, 120, 380, 500], top: 690 }),
    ]))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(renderedRows).toContainEqual(['31 December', '120', '105'])
  })

  it('keeps repeated wrapped labels attached to their individual columns', async () => {
    const rows = [
      ['Floorplan', 'Average', 'Average', 'Average'],
      ['Name', 'SQFT', 'Market Rent', 'Leased Rent'],
      ['A1', '850', '1,700.00', '1,650.00'],
      ['A2', '900', '1,800.00', '1,750.00'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 5,
      starts: [50, 180, 260, 340, 430],
    })))

    expect(html[0]).not.toContain('scope="colgroup"')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      'Floorplan\nName',
      'Average\nSQFT',
      'Average\nMarket Rent',
      'Average\nLeased Rent',
    ])
  })

  it('keeps repeated group totals attached to their table columns', async () => {
    const starts = [120, 220, 320, 420]
    const runs = [
      { text: 'Group', x: 50, y: 800, size: 5 },
      ...tableRuns([
        ['Floor Plan', 'Units', 'Vacant', 'Occupied'],
      ], { size: 5, starts, top: 800 }),
      { text: '1-1', x: 50, y: 785, size: 5 },
      ...tableRuns([
        ['A1', '20', '2', '18'],
      ], { size: 5, starts, top: 775 }),
      { text: 'Total 1-1', x: 50, y: 765, size: 5 },
      ...tableRuns([
        ['', '20', '2', '18'],
      ], { size: 5, starts, top: 765 }),
      { text: '2-2', x: 50, y: 750, size: 5 },
      ...tableRuns([
        ['B1', '30', '1', '29'],
      ], { size: 5, starts, top: 740 }),
      { text: 'Total 2-2', x: 50, y: 730, size: 5 },
      ...tableRuns([
        ['', '30', '1', '29'],
      ], { size: 5, starts, top: 730 }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual(['Group', 'Floor Plan', 'Units', 'Vacant', 'Occupied'])
    expect(htmlText(html[0]!)).toContain('1-1')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual(['Total 1-1', '', '20', '2', '18'])
  })

  it('keeps wrapped descriptions inside their table record', async () => {
    const runs = [
      ...tableRuns([
        ['Date', 'Description', 'Reference', 'Amount'],
        ['05/07/26', 'Wire transfer', '903705070470364', '-320,000.00'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
      }),
      { text: 'Beneficiary: Example Holdings', x: 150, y: 765, size: 5 },
      { text: 'May mortgage payment', x: 150, y: 757.5, size: 5 },
      ...tableRuns([
        ['05/08/26', 'Card payment', '906627018958577', '-3,661.39'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
        top: 750,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      '05/07/26',
      'Wire transfer\nBeneficiary: Example Holdings\nMay mortgage payment',
      '903705070470364',
      '-320,000.00',
    ])
    expect(html[0]).not.toContain('<p>Beneficiary: Example Holdings</p>')
  })

  it('keeps vertically centered multiline records in one table', async () => {
    const runs = [
      ...tableRuns([
        ['Date', 'Description', 'Reference', 'Amount'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
        top: 800,
      }),
      { text: 'First description begins', x: 150, y: 764, size: 5 },
      ...tableRuns([
        ['05/07/26', 'Wire transfer', '903705070470364', '-320,000.00'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
        top: 760,
      }),
      { text: 'and ends here', x: 150, y: 756, size: 5 },
      { text: 'Second description begins', x: 150, y: 724, size: 5 },
      ...tableRuns([
        ['05/08/26', 'Card payment', '906627018958577', '-3,661.39'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
        top: 720,
      }),
      { text: 'and ends later', x: 150, y: 716, size: 5 },
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      '05/07/26',
      'First description begins\nWire transfer\nand ends here',
      '903705070470364',
      '-320,000.00',
    ])
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      '05/08/26',
      'Second description begins\nCard payment\nand ends later',
      '906627018958577',
      '-3,661.39',
    ])
  })

  it('attaches a final wrapped cell line that falls beyond the detected table range', async () => {
    const runs = [
      ...tableRuns([
        ['Unit', 'Resident', 'Consultant', 'Amount'],
        ['101', 'First Resident', 'Montano,', '1,700.00'],
      ], {
        size: 5,
        starts: [50, 160, 350, 500],
        top: 800,
      }),
      { text: 'Tonirhea', x: 350, y: 785, size: 5 },
      ...tableRuns([
        ['102', 'Second Resident', 'Montano,', '1,800.00'],
      ], {
        size: 5,
        starts: [50, 160, 350, 500],
        top: 760,
      }),
      { text: 'Tonirhea', x: 350, y: 750, size: 5 },
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(rows).toContainEqual(['102', 'Second Resident', 'Montano,\nTonirhea', '1,800.00'])
    expect(html[0]).not.toContain('<p>Tonirhea</p>')
  })

  it('keeps wrapped names and move-out dates in their record', async () => {
    const { html } = await extractHTML(authorPdf(tableRuns([
      ['Unit', 'Name', 'Move-In/Move-Out', 'Amount'],
      ['14306', 'Babadjanian,', '07/10/2024', '2,293.00'],
      ['', 'Angela', '07/09/2026', ''],
      ['14307', 'Next Resident', '08/01/2024', '2,400.00'],
    ], {
      size: 5,
      starts: [50, 160, 350, 500],
      top: 800,
    })))

    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      '14306',
      'Babadjanian,\nAngela',
      '07/10/2024\n07/09/2026',
      '2,293.00',
    ])
  })

  it('inherits report context on a tabular continuation page', async () => {
    const firstPage = [
      { text: 'Account Activity', x: 50, y: 810, size: 12 },
      ...tableRuns([
        ['Date', 'Description', 'Reference', 'Amount'],
        ['05/07/26', 'Wire transfer', '903705070470364', '-320,000.00'],
      ], {
        size: 5,
        starts: [50, 150, 390, 500],
      }),
    ]
    const secondPage = tableRuns([
      ['05/08/26', 'Card payment', '906627018958577', '-3,661.39'],
      ['05/09/26', 'Deposit', '906627018958588', '2,000.00'],
    ], {
      size: 5,
      starts: [50, 150, 390, 500],
    })
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))

    expect(html[1]).toContain('<h1>Account Activity (continued)</h1>')
    expect(htmlRows(html[1]!).map(htmlCells)).toContainEqual(['Date', 'Description', 'Reference', 'Amount'])
  })

  it('uses a new report title instead of inheriting the previous page title', async () => {
    const firstPage = [
      { text: 'Prior Report', x: 50, y: 810, size: 12 },
      ...tableRuns([
        ['Date', 'Description', 'Reference', 'Amount'],
        ['05/07/26', 'Wire transfer', '903705070470364', '-320,000.00'],
      ], { size: 5, starts: [50, 150, 390, 500] }),
    ]
    const secondPage = [
      { text: 'Reports - Account Activity', x: 180, y: 820, size: 6 },
      { text: 'Account Activity', x: 220, y: 800, size: 6 },
      ...tableRuns([
        ['Date', 'Description', 'Reference', 'Amount'],
        ['05/08/26', 'Card payment', '906627018958577', '-3,661.39'],
      ], { size: 5, starts: [50, 150, 390, 500], top: 770 }),
    ]
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))

    expect(html[1]).toContain('>Account Activity</h2>')
    expect(html[1]).not.toContain('Prior Report (continued)')
  })

  it('restores packed continuation columns from the preceding table schema', async () => {
    const firstPage = [
      { text: 'Boxscore', x: 50, y: 820, size: 12 },
      ...tableRuns([
        ['Floor Plan', 'Total', 'No Lease', 'Lease', 'Total', 'No NTV', 'Occupancy', 'Average Rent'],
        ['Group', 'Vacant', 'Application', 'Applications', 'Occupied', 'NTV', 'Percent', 'Rent'],
        ['A1', '3', '0', '3', '31', '29', '91.18', '1,769.85'],
      ], {
        size: 4,
        starts: [30, 120, 190, 270, 350, 420, 490, 545],
      }),
    ]
    const secondPage = [
      { text: 'Boxscore', x: 50, y: 820, size: 12 },
      ...tableRuns([
        ['Floor Plan Total', 'No Lease Lease', 'Total No NTV', 'Occupancy', 'Average Rent'],
        ['Group Vacant', 'Application Applications', 'Occupied NTV', 'Percent', 'Rent'],
        ['Property Totals:', '281 29', '17 10', '252 232', '89.68'],
      ], {
        size: 4,
        starts: [30, 155, 280, 405, 490],
      }),
    ]
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))
    const secondPageRows = htmlRows(html[1]!).map(htmlCells)

    expect(secondPageRows.some(row => row.length === 8)).toBe(true)
    expect(secondPageRows).toContainEqual([
      'Property Totals:',
      '281',
      '29',
      '17',
      '10',
      '252',
      '232',
      '89.68',
    ])
  })

  it('does not inherit a wider schema for a newly named table section', async () => {
    const firstPage = [
      { text: 'Boxscore', x: 50, y: 820, size: 12 },
      { text: 'Move-Ins - May 2026', x: 50, y: 800, size: 8 },
      ...tableRuns([
        ['Floor Plan', 'Total', 'No Lease', 'Lease', 'Total', 'No NTV', 'Occupancy', 'Average Rent'],
        ['Group', 'Vacant', 'Application', 'Applications', 'Occupied', 'NTV', 'Percent', 'Rent'],
        ['A1', '3', '0', '3', '31', '29', '91.18', '1,769.85'],
      ], {
        size: 4,
        starts: [30, 120, 190, 270, 350, 420, 490, 545],
        top: 780,
      }),
    ]
    const secondPage = [
      { text: 'Boxscore', x: 50, y: 820, size: 12 },
      { text: 'Vacancies - June 2026', x: 50, y: 800, size: 8 },
      ...tableRuns([
        ['Floor Plan Total', 'No Lease Lease', 'Total No NTV', 'Occupancy', 'Average Rent'],
        ['Group Vacant', 'Application Applications', 'Occupied NTV', 'Percent', 'Rent'],
        ['Property Totals:', '281 29', '17 10', '252 232', '89.68'],
      ], {
        size: 4,
        starts: [30, 155, 280, 405, 490],
        top: 780,
      }),
    ]
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))
    const secondPageRows = htmlRows(html[1]!).map(htmlCells)

    expect(html[1]).toContain('<h2>Vacancies - June 2026</h2>')
    expect(secondPageRows).toContainEqual([
      'Floor Plan Total',
      'No Lease Lease',
      'Total No NTV',
      'Occupancy',
      'Average Rent',
    ])
    expect(secondPageRows.every(row => row.length === 5)).toBe(true)
  })

  it('does not inflate a complete table to a much wider preceding schema', async () => {
    const firstPage = [
      { text: 'Rent detail', x: 50, y: 820, size: 12 },
      ...tableRuns([
        [
          'Unit Status',
          'Floorplan',
          'Unit Designation',
          'SQFT',
          'Market Addl',
          'Potential Rent',
          'Name',
          'Lease Start',
          'Lease End',
          'Balance',
        ],
        ['101', 'A1', 'North', '850', '1,700.00', '1,650.00', 'Resident', '01/01/26', '12/31/26', '0.00'],
      ], {
        size: 4,
        starts: [20, 75, 130, 190, 235, 300, 365, 415, 475, 540],
      }),
    ]
    const secondPage = tableRuns([
      ['Unit Status', 'Market Addl', '# Units', 'Potential Rent'],
      ['Occupied', '498,264.00', '228', '466,318.00'],
      ['Vacant', '45,920.00', '20', '45,920.00'],
    ], {
      size: 5,
      starts: [50, 210, 350, 450],
    })
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))
    const secondPageRows = htmlRows(html[1]!).map(htmlCells)

    expect(secondPageRows).toContainEqual(['Unit Status', 'Market Addl', '# Units', 'Potential Rent'])
    expect(secondPageRows).toContainEqual(['Occupied', '498,264.00', '228', '466,318.00'])
    expect(secondPageRows.every(row => row.length === 4)).toBe(true)
  })

  it('promotes a short table caption to a section heading', async () => {
    const runs = [
      { text: 'Your Checking Account', x: 50, y: 810, size: 12 },
      { text: 'Account Summary', x: 50, y: 785, size: 8 },
      ...tableRuns([
        ['Beginning balance', '$227,245.29'],
        ['Ending balance', '$311,374.35'],
      ], {
        size: 8,
        starts: [50, 320],
        top: 765,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('<h2>Account Summary</h2>')
  })

  it('preserves a narrative note beside a report label', async () => {
    const note = 'This note describes the complete reporting scope across every selected comparison property since June'
    const runs = [
      ...tableRuns([
        ['Market Analysis', 'As of: 6/15/2026'],
        ['Unit-Level Detail', note],
      ], {
        size: 6,
        starts: [40, 220],
        top: 820,
      }),
      { text: '2023.', x: 220, y: 800, size: 6 },
      ...tableRuns([
        ['Property', 'Address', 'Rent'],
        ['Example', '100 Main Street', '$1,500'],
      ], {
        size: 5,
        starts: [40, 220, 500],
        top: 775,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('<h1>Market Analysis</h1>')
    expect(html[0]).toContain('<h2>Unit-Level Detail</h2>')
    expect(html[0]).toContain(`${note} 2023.`)
    expect(html[0]).not.toContain('<h2>2023.</h2>')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual(['Property', 'Address', 'Rent'])
  })

  it('promotes a lower-case table caption to a section heading', async () => {
    const runs = [
      { text: 'Rent Detail', x: 50, y: 810, size: 12 },
      { text: 'Area = 292,185 SQFT; Leased = 260,328 SQFT;', x: 50, y: 795, size: 8 },
      { text: 'occupancy and rents summary for current date', x: 50, y: 785, size: 8 },
      ...tableRuns([
        ['Unit status', 'Market rent', '# units', 'Potential rent'],
        ['Occupied', '498,264.00', '228', '466,318.00'],
      ], {
        size: 6,
        starts: [50, 220, 350, 450],
        top: 765,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('<h2>occupancy and rents summary for current date</h2>')
    expect(html[0]).toContain('<p>Area = 292,185 SQFT; Leased = 260,328 SQFT;</p>')
  })

  it('preserves narrative report hierarchy and labels', async () => {
    const lines = [
      'MONTHLY OPERATIONS',
      'Example Property',
      'March 2027',
      'Occupancy improved during the month.',
      'Resident Retention: Provide an overview of resident events.',
      '- Send resident surveys.',
      'Goals for Next Month',
      '- Reach occupancy over 92%.',
      'Community Staffing',
      'Community Manager: Susan Kexel',
      'Service Supervisor: Kelly Hamilton',
    ]
    const runs = lines.map((text, lineIndex) => ({
      text,
      x: lineIndex < 3 ? 240 : 50,
      y: 800 - lineIndex * 14,
      size: lineIndex < 3 ? 8 : 6,
    }))
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('<h1>MONTHLY OPERATIONS</h1>')
    expect(html[0]).toContain('<h2>Resident Retention</h2>')
    expect(html[0]).toContain('<h2>Goals for Next Month</h2>')
    expect(html[0]).toContain('<h2>Community Staffing</h2>')
    expect(html[0]).toContain('<em>March 2027</em>')
    expect(html[0]).toContain('<li><strong>Community Manager:</strong> Susan Kexel</li>')
  })

  it('keeps a centered caption outside stacked table headers', async () => {
    const runs = [
      { text: 'Unit', x: 50, y: 810, size: 5 },
      ...tableRuns([
        ['', '', 'Lease Renewal Detail', '', '', ''],
        ['', '', 'Last', '', 'New', ''],
        ['', 'Actual', 'Increase', 'Market', 'Other', 'Leasing'],
        ['', 'rent', 'Amount', 'Rent', 'Billings', 'Consultant'],
        ['4108', '2135.00', '-37.00', '2135.00', '193', 'Nicole'],
        ['4202', '2125.00', '0.00', '2125.00', '113', 'Susan'],
      ], {
        size: 5,
        starts: [50, 150, 250, 350, 450, 520],
        top: 790,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('<h1>Lease Renewal Detail</h1>')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      'Unit',
      'Actual\nrent',
      'Last\nIncrease\nAmount',
      'Market\nRent',
      'New\nOther\nBillings',
      'Leasing\nConsultant',
    ])
    expect(html[0]).not.toContain('Lease Renewal Detail<br>Last')
  })

  it('separates adjacent headers and numeric values merged by visual extraction', async () => {
    const runs = [
      { text: 'Resident Activity', x: 40, y: 820, size: 12 },
      { text: 'Market', x: 350, y: 795, size: 8 },
      { text: 'Unit', x: 40, y: 780, size: 8 },
      { text: 'Name', x: 120, y: 780, size: 8 },
      { text: 'Reason', x: 240, y: 780, size: 8 },
      { text: 'Rent', x: 350, y: 780, size: 8 },
      { text: 'Effective Rent', x: 390, y: 778, size: 8 },
      { text: '101', x: 40, y: 760, size: 8 },
      { text: 'Example Resident', x: 120, y: 760, size: 8 },
      { text: 'Transfer', x: 240, y: 760, size: 8 },
      { text: '2,205.00 2,168.00', x: 350, y: 760, size: 8 },
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(rows).toContainEqual(['Unit', 'Name', 'Reason', 'Market\nRent', 'Effective Rent'])
    expect(rows).toContainEqual(['101', 'Example Resident', 'Transfer', '2,205.00', '2,168.00'])
  })

  it('keeps a report preamble outside its stacked-header table', async () => {
    const runs = [
      { text: 'Lease Renewal Detail', x: 200, y: 830, size: 14 },
      { text: 'Unit', x: 50, y: 805, size: 5 },
      ...tableRuns([
        ['Report', '', 'Report created on June 14', '', '', '06/14/2026'],
        ['Status', '', 'Current residents', '', '', '01/01/1980'],
        ['', '', 'Last', '', 'New', ''],
        ['', 'Actual', 'Increase', 'Market', 'Other', 'Leasing'],
        ['', 'rent', 'Amount', 'Rent', 'Billings', 'Consultant'],
        ['4108', '2135.00', '-37.00', '2135.00', '193', 'Nicole'],
        ['4202', '2125.00', '0.00', '2125.00', '113', 'Susan'],
      ], {
        size: 5,
        starts: [50, 150, 250, 350, 450, 520],
        top: 780,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).toContain('Report created on June 14')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual([
      'Unit',
      'Actual\nrent',
      'Last\nIncrease\nAmount',
      'Market\nRent',
      'New\nOther\nBillings',
      'Leasing\nConsultant',
    ])
    expect(htmlRows(html[0]!).map(htmlCells)).not.toContainEqual(expect.arrayContaining(['Report created on June 14']))
  })

  it('keeps a sparse leading record below stacked headers', async () => {
    const rows = [
      ['', '', 'Resident', '', 'Charge', 'Credit'],
      ['Unit', 'Plan', 'Name', 'Code', 'Debit', 'Balance'],
      ['', '', 'Prior Resident', 'TRASH', '0.00', '25.00'],
      ['101', 'A1', 'Current Resident', 'RENT', '1,700.00', '400.00 0.00'],
      ['102', 'A1', 'Following Resident', 'RENT', '1,725.00', '400.00 0.00'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      starts: [40, 100, 160, 280, 360, 440],
      size: 6,
    })))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows[0]).toHaveLength(6)
    expect(renderedRows).toContainEqual(expect.arrayContaining([
      'Prior Resident',
      'TRASH',
      '0.00',
      '25.00',
    ]))
  })

  it('keeps sparse identifier rows out of a stacked header', async () => {
    const rows = [
      ['', '', 'Actual', 'Budget', 'Variance'],
      ['', '', 'May 2026', 'June 2026', '%'],
      ['40000-000', 'Income', '', '', ''],
      ['40001-000', 'Residential Income', '', '', ''],
      ['', 'Continued description', '', '', ''],
      ['41000-000', 'Market Rent', '500.00', '525.00', '-4.76'],
      ['41010-000', 'Loss to Lease', '-25.00', '0.00', 'N/A'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      starts: [40, 130, 300, 380, 460],
      size: 6,
    })))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows[0]).toEqual(['', '', 'Actual\nMay 2026', 'Budget\nJune 2026', 'Variance\n%'])
    expect(renderedRows).toContainEqual(['40000-000', 'Income', '', '', ''])
    expect(renderedRows).toContainEqual([
      '40001-000',
      'Residential Income\nContinued description',
      '',
      '',
      '',
    ])
  })

  it('attaches wrapped trailing financial values to their record', async () => {
    const starts = [40, 110, 240, 300, 360, 420, 480, 540]
    const runs = [
      ...['Code', 'Description', 'Jan', 'Feb', 'Total', 'Budget', 'Variance', '%']
        .map((text, columnIndex) => ({ text, x: starts[columnIndex]!, y: 790, size: 6 })),
      { text: '40000', x: starts[0]!, y: 780, size: 6 },
      { text: 'Income', x: starts[1]!, y: 780, size: 6 },
      ...['41000', 'Market Rent', '100.00', '110.00', '', '-', '- -25.00', '5.00']
        .flatMap((text, columnIndex) => text
          ? [{ text, x: starts[columnIndex]!, y: 770, size: 6 }]
          : []),
      { text: '500.00', x: starts[4]!, y: 766, size: 6 },
      { text: '525.00', x: starts[5]!, y: 766, size: 6 },
      ...['41010', 'Loss to Lease', '-10.00', '0.00', '90.00', '100.00', '-10.00', '-10.00']
        .map((text, columnIndex) => ({ text, x: starts[columnIndex]!, y: 745, size: 6 })),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      '41000',
      'Market Rent',
      '100.00',
      '110.00',
      '500.00',
      '525.00',
      '-25.00',
      '5.00',
    ])
  })

  it('uses a separated final header row to unpack merged record columns', async () => {
    const starts = [40, 100, 145, 260, 380, 500]
    const runs = [
      { text: 'Lease Renewal Detail', x: 200, y: 830, size: 14 },
      ...tableRuns([
        ['', '', 'Report created on June 14', '', '', '06/14/2026'],
        ['', '', 'Statuses: Current residents', '', '', ''],
        ['', '', 'Unit Number', '', '', ''],
      ], {
        size: 5,
        starts,
        top: 790,
      }),
      ...tableRuns([
        ['', '', 'Last', '', 'New', ''],
        ['Unit', 'Floorplan', 'Name', 'Actual rent', 'New rent', 'Consultant'],
      ], {
        size: 5,
        starts,
        top: 750,
      }),
      { text: '1601', x: starts[0]!, y: 730, size: 5 },
      { text: 'TA1', x: starts[1]!, y: 730, size: 5 },
      { text: 'Scott Haugh', x: starts[2]!, y: 730, size: 5 },
      { text: '1969.00', x: starts[3]!, y: 730, size: 5 },
      { text: '2028.00', x: starts[4]!, y: 730, size: 5 },
      { text: 'Tonirhea', x: starts[5]!, y: 730, size: 5 },
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(rows).toContainEqual(['1601', 'TA1', 'Scott Haugh', '1969.00', '2028.00', 'Tonirhea'])
    expect(html[0]).toContain('<p>Statuses: Current residents</p>')
    expect(html[0]).not.toContain('Statuses: Current residents<br>')
  })

  it('keeps labeled report parameters outside a stacked table header', async () => {
    const runs = [
      { text: 'Resident Deposit Activity', x: 180, y: 820, size: 12 },
      ...tableRuns([
        ['Parameters:', '', 'Sub Properties - ALL; Resident Status - All;', '', '', '', '', ''],
        ['', '', '', '', '', 'i', '+', '-'],
        ['', '', '', 'Beginning', '', 'Transaction', 'Transaction', 'Deposit'],
        ['', '', '', '', '', '***', '***', ''],
        ['', 'This Period', '', '', 'This Period', '', '', ''],
        ['Unit', 'Name', 'Status', 'Balance', 'Date', 'Code', 'Description', 'Out'],
        ['1505', 'First Resident', 'Former', '500.00', '04/29/2026', 'APPLYDEP', 'Apply Deposit', '67.49'],
      ], {
        size: 5,
        starts: [30, 90, 180, 260, 325, 390, 465, 555],
        top: 790,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!).map(htmlCells)
    const tableHeader = /<thead>[\s\S]*?<\/thead>/.exec(html[0]!)?.[0]

    expect(html[0]).toContain('<p>Parameters: Sub Properties - ALL; Resident Status - All;</p>')
    expect(tableHeader).not.toContain('Parameters:')
    expect(rows).toContainEqual([
      '1505',
      'First Resident',
      'Former',
      '500.00',
      '04/29/2026',
      'APPLYDEP',
      'Apply Deposit',
      '67.49',
    ])
  })

  it('recognizes numeric aging labels and reattaches a detached column label', async () => {
    const starts = [40, 120, 220, 300, 390, 470, 540]
    const runs = [
      { text: 'Delinquent and Prepaid', x: 180, y: 820, size: 12 },
      { text: 'Name', x: starts[1]!, y: 805, size: 5 },
      ...tableRuns([
        ['Unit', 'Phone Number', '', 'Total', '30', '60', '90+'],
        ['', 'Email', 'Status', 'Balance', 'Days', 'Days', 'Days'],
        ['1802', 'First Resident', 'Current', '500.00', '0.00', '0.00', '0.00'],
      ], {
        size: 5,
        starts,
        top: 785,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]).toContain('<thead>')
    expect(html[0]).not.toContain('scope="colgroup"')
    expect(rows).toContainEqual([
      'Unit',
      'Name\nPhone Number\nEmail',
      'Status',
      'Total\nBalance',
      '30\nDays',
      '60\nDays',
      '90+\nDays',
    ])
    expect(html[0]).not.toContain('<p>Name</p>')
    expect(rows).toContainEqual([
      '1802',
      'First Resident',
      'Current',
      '500.00',
      '0.00',
      '0.00',
      '0.00',
    ])
  })

  it('normalizes account continuations into complete transaction rows', async () => {
    const { html } = await extractHTML(authorPdf(tableRuns([
      ['Unit', 'Phone Number Email', 'Status', 'Move-In/Out', 'Code Description', 'Total Prepaid', 'Total Delinquent', 'Current'],
      ['1802', 'Hill, Zachary Robert', 'Current', '03/17/2026', 'CONC/REFE', '(750.00)', '0.00', '(750.00)'],
      ['', '(410) 793-1656', 'resident', '', 'RRAL', '', '', ''],
      ['3003', 'Dawes, Lisa Catherine', 'Current resident', '04/18/2026', 'CONC/UP', '(658.72)', '0.00', '(658.72)'],
      ['', '(608) 406-6768', '', '', 'PMTOPACH', '(658.72)', '0.00', '(658.72)'],
      ['', 'lisa@example.com', '', '', 'Subtotals:', '(1,317.44)', '0.00', '(1,317.44)'],
    ], {
      size: 4,
      starts: [20, 75, 190, 260, 325, 405, 475, 550],
      top: 800,
    })))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(rows).toContainEqual([
      '1802',
      'Hill, Zachary Robert\n(410) 793-1656',
      'Current\nresident',
      '03/17/2026',
      'CONC/REFE\nRRAL',
      '(750.00)',
      '0.00',
      '(750.00)',
    ])
    const accountRows = rows.filter(row => row[0] === '3003')
    expect(accountRows).toHaveLength(3)
    expect(accountRows.every(row => row[1] === 'Dawes, Lisa Catherine\n(608) 406-6768\nlisa@example.com')).toBe(true)
    expect(accountRows.map(row => row[4])).toEqual(['CONC/UP', 'PMTOPACH', 'Subtotals:'])
    expect(html[0]).toContain('tbody th[scope="row"] { font-weight: 400; }')
  })

  it('repeats account fields for transactions continued on the next page', async () => {
    const header = ['Unit', 'Phone Number Email', 'Status', 'Move-In/Out', 'Code Description', 'Total Prepaid', 'Total Delinquent', 'Current']
    const firstPage = [
      { text: 'Delinquent and Prepaid', x: 180, y: 820, size: 12 },
      ...tableRuns([
        header,
        ['3003', 'Dawes, Lisa', 'Current resident', '04/18/2026', 'CONC/UP', '(658.72)', '0.00', '(658.72)'],
      ], {
        size: 4,
        starts: [20, 75, 190, 260, 325, 405, 475, 550],
        top: 800,
      }),
    ]
    const secondPage = tableRuns([
      header,
      ['', '', '', '', 'PMTOPACH', '(658.72)', '0.00', '(658.72)'],
      ['', '', '', '', 'Subtotals:', '(1,317.44)', '0.00', '(1,317.44)'],
      ['4004', 'Next Resident', 'Current resident', '05/01/2026', 'RENT', '0.00', '500.00', '500.00'],
    ], {
      size: 4,
      starts: [20, 75, 190, 260, 325, 405, 475, 550],
      top: 800,
    })
    const { html } = await extractHTML(authorPdf(firstPage, [secondPage]))
    const rows = htmlRows(html[1]!).map(htmlCells)
    const continuedRows = rows.filter(row => row[0] === '3003')

    expect(continuedRows).toHaveLength(2)
    expect(continuedRows.every(row =>
      row[1] === 'Dawes, Lisa'
      && row[2] === 'Current resident'
      && row[3] === '04/18/2026')).toBe(true)
    expect(continuedRows.map(row => row[4])).toEqual(['PMTOPACH', 'Subtotals:'])
    expect(rows).toContainEqual([
      '4004',
      'Next Resident',
      'Current resident',
      '05/01/2026',
      'RENT',
      '0.00',
      '500.00',
      '500.00',
    ])
  })

  it('renders vertically separated report grids as independent tables', async () => {
    const runs = [
      { text: '6/14/26, 1:27 PM', x: 50, y: 825, size: 5 },
      { text: 'Lease Renewal Detail', x: 280, y: 825, size: 5 },
      { text: 'Floor Plan', x: 50, y: 790, size: 5 },
      { text: 'Total Possible', x: 220, y: 790, size: 5 },
      { text: 'Renewed', x: 340, y: 790, size: 5 },
      { text: 'Average Rent', x: 460, y: 790, size: 5 },
      ...tableRuns([
        ['A1', '29', '29', '1,701.45'],
        ['B1', '20', '20', '2,174.80'],
        ['C1', '21', '21', '2,613.43'],
      ], {
        size: 5,
        starts: [100, 220, 340, 460],
        top: 780,
      }),
      ...tableRuns([
        ['Floor Plan', '0 - 30 days', '31 - 60 days', '61 - 90 days', '91+ days'],
        ['A1', '0', '0', '0', '0'],
        ['B1', '1', '0', '0', '0'],
      ], {
        size: 5,
        starts: [100, 200, 300, 400, 500],
        top: 700,
      }),
      { text: 'Leasing Consultant', x: 100, y: 610, size: 5 },
      { text: 'Month to month', x: 230, y: 610, size: 5 },
      { text: 'Expiring this month', x: 360, y: 610, size: 5 },
      { text: '(June)', x: 390, y: 610, size: 5 },
      { text: 'Future', x: 490, y: 610, size: 5 },
      ...tableRuns([
        ['House', '0', '0', '0'],
        ['kenyasia maxwell', '0', '0', '0'],
      ], {
        size: 5,
        starts: [100, 230, 360, 490],
        top: 600,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]!.match(/<table>/g)).toHaveLength(3)
    const rows = htmlRows(html[0]!)
    expect(rows.map(htmlCells)).toContainEqual(['Floor Plan', 'Total Possible', 'Renewed', 'Average Rent'])
    expect(rows.map(htmlCells)).toContainEqual(['Floor Plan', '0 - 30 days', '31 - 60 days', '61 - 90 days', '91+ days'])
    const leasingHeaderCells = rows.map(htmlCells)
      .find(cells => cells[0] === 'Leasing Consultant')!
    expect(leasingHeaderCells).toHaveLength(4)
    expect(leasingHeaderCells[1]).toBe('Month to month')
    expect(leasingHeaderCells[2]).toContain('Expiring this month')
    expect(leasingHeaderCells[2]).toContain('(June)')
    expect(leasingHeaderCells[3]).toBe('Future')
    expect(html[0]).toContain('<h1>Lease Renewal Detail</h1>')
    expect(html[0]).toContain('<p>6/14/26, 1:27 PM</p>')
    expect(rows.map(htmlCells).flat()).not.toContain('6/14/26, 1:27 PM')
  })

  it('separates parallel status grids instead of interleaving their columns', async () => {
    const runs = [
      { text: 'Boxscore', x: 50, y: 825, size: 12 },
      { text: 'Availability/Exposure - 06/13/2026', x: 30, y: 800, size: 5 },
      { text: 'Make Ready Status - 06/13/2026', x: 310, y: 800, size: 5 },
      ...tableRuns([
        ['Status', 'Number', '%', 'Status', 'Number', '%', 'Available'],
        ['Total Vacant Units:', '29', '10.32', 'Made Ready:', '16', '55.17', '6'],
        ['Vacant Units Leased:', '(10)', '3.56', 'Not Made Ready:', '13', '44.83', '11'],
      ], {
        size: 5,
        starts: [30, 190, 250, 310, 455, 515, 560],
        top: 780,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]).toContain('<div class="parallel-tables"')
    expect(html[0]).toContain('<h3>Availability/Exposure - 06/13/2026</h3>')
    expect(html[0]).toContain('<h3>Make Ready Status - 06/13/2026</h3>')
    expect(renderedRows).toContainEqual(['Total Vacant Units:', '29', '10.32'])
    expect(renderedRows).toContainEqual(['Made Ready:', '16', '55.17', '6'])
  })

  it('uses header-only columns as titles for adjacent tables', async () => {
    const runs = [
      { text: 'Portfolio Status', x: 50, y: 825, size: 12 },
      ...tableRuns([
        ['Status', 'Availability Summary', 'Number', '%', 'Status', 'Readiness Summary', 'Number', '%', 'Available'],
        ['Vacant:', '', '29', '10.32', 'Ready:', '', '16', '55.17', '6'],
        ['Leased:', '', '10', '3.56', 'Not Ready:', '', '13', '44.83', '11'],
      ], {
        size: 5,
        starts: [20, 90, 220, 290, 320, 380, 470, 525, 575],
        top: 790,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]).toContain('<h3>Availability Summary</h3>')
    expect(html[0]).toContain('<h3>Readiness Summary</h3>')
    expect(renderedRows).toContainEqual(['Vacant:', '29', '10.32'])
    expect(renderedRows).toContainEqual(['Ready:', '16', '55.17', '6'])
  })

  it('separates repeated column groups into parallel tables', async () => {
    const runs = [
      { text: 'Checks', x: 30, y: 825, size: 12 },
      ...tableRuns([
        ['Date', 'Check #', 'Bank reference', 'Amount', 'Date', 'Check #', 'Bank reference', 'Amount'],
        ['05/18', '848', '813004592797534', '-753.38', '05/13', '857*', '813004492767391', '-683.42'],
        ['05/12', '849', '813008652466960', '-132.38', '05/11', '859*', '813009692686648', '-279.83'],
        ['', '', '', '', 'Total checks', '', '', '-1,848.93'],
      ], {
        size: 5,
        starts: [30, 75, 115, 210, 315, 360, 400, 520],
        top: 800,
      }),
      { text: 'Daily balances', x: 30, y: 690, size: 12 },
      ...tableRuns([
        ['Date', 'Balance ($)', 'Date', 'Balance($)', 'Date', 'Balance ($)'],
        ['04/26', '227,245.29', '05/05', '633,060.99', '05/14', '319,573.35'],
        ['04/27', '238,518.83', '05/06', '634,116.11', '05/15', '302,225.12'],
      ], {
        size: 5,
        starts: [30, 105, 220, 295, 410, 485],
        top: 665,
      }),
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<div class="parallel-tables"/g)).toHaveLength(2)
    expect(html[0]!.match(/<table>/g)).toHaveLength(5)
    expect(renderedRows).toContainEqual(['05/18', '848', '813004592797534', '-753.38'])
    expect(renderedRows).toContainEqual(['05/13', '857*', '813004492767391', '-683.42'])
    expect(renderedRows).toContainEqual(['Total checks', '', '', '-1,848.93'])
    expect(renderedRows).toContainEqual(['04/26', '227,245.29'])
    expect(renderedRows).toContainEqual(['05/05', '633,060.99'])
    expect(renderedRows).toContainEqual(['05/14', '319,573.35'])
  })

  it('renders alphabetic outline entries as a nested ordered list', async () => {
    const outline = [
      { text: 'Contents', x: 50, y: 810, size: 18 },
      { text: '1. First Section', x: 90, y: 780, size: 14 },
      { text: 'a. First Topic', x: 125, y: 760, size: 12 },
      { text: 'b. Second Topic', x: 125, y: 740, size: 12 },
      { text: '2 Second Section', x: 90, y: 710, size: 14 },
      { text: 'a. Third Topic', x: 125, y: 690, size: 12 },
      { text: 'b. Fourth Topic', x: 125, y: 670, size: 12 },
    ]
    const { html } = await extractHTML(authorPdf(outline))

    expect(html[0]).toContain('<h1>Contents</h1>')
    expect(html[0]!.match(/<ol(?: type="a")?>/g)).toHaveLength(3)
    expect(html[0]).toContain('<li>First Section\n<ol type="a">')
    expect(html[0]!.match(/<ol type="a">/g)).toHaveLength(2)
    expect(html[0]).toContain('<li>First Topic</li>')
    expect(html[0]).toContain('<li>Fourth Topic</li>')
  })

  it('adds ordered-list markers to a sequential numeric outline', async () => {
    const outline = [
      { text: 'Document Index', x: 50, y: 810, size: 18 },
      { text: '1 First Section', x: 90, y: 780, size: 12 },
      { text: '2 Second Section', x: 90, y: 760, size: 12 },
      { text: '3 Third Section', x: 90, y: 740, size: 12 },
      { text: '4 Fourth Section', x: 90, y: 720, size: 12 },
    ]
    const { html } = await extractHTML(authorPdf(outline))

    expect(html[0]).toContain('<h1>Document Index</h1>')
    expect(html[0]!.match(/<ol>/g)).toHaveLength(1)
    expect(html[0]).toContain('<li>First Section</li>')
    expect(html[0]).toContain('<li>Fourth Section</li>')
  })

  it('does not interpret sequential record identifiers as an outline', async () => {
    const records = [
      { text: 'Record Detail', x: 50, y: 810, size: 18 },
      { text: '1501 TB1', x: 90, y: 780, size: 12 },
      { text: '1502 TB1', x: 90, y: 760, size: 12 },
      { text: '1503 TB1', x: 90, y: 740, size: 12 },
      { text: '1504 TB1', x: 90, y: 720, size: 12 },
    ]
    const { html } = await extractHTML(authorPdf(records))

    expect(htmlText(html[0]!)).toContain('1501 TB1\n1502 TB1\n1503 TB1\n1504 TB1')
    expect(html[0]).not.toContain('1501. TB1')
  })

  it('does not interpret a literal source marker as an inferred heading', async () => {
    const { html } = await extractHTML(authorPdf([
      { text: '# For Internal Use Only', x: 50, y: 780, size: 8 },
    ]))

    expect(html[0]).toContain('<p># For Internal Use Only</p>')
    expect(html[0]).not.toContain('<h1>For Internal Use Only</h1>')
  })

  it('keeps sidebar controls outside a dense table', async () => {
    const rows = [
      ['Property', 'Beds', 'Baths', 'Units', 'Rent', 'NER'],
      ['Allaso', '1', '1', '34', '$1,611', '$1,607'],
      ['', '1', '1', '18', '$1,658', '$1,658'],
      ['Total', '', '', '52', '$1,627', '$1,625'],
    ]
    const reportRuns = tableRuns(rows)
    const sidebarRuns = [
      { text: 'Property Name', x: 30, y: 774, size: 4.4 },
      { text: 'Allaso High Desert', x: 30, y: 768, size: 4.4 },
      { text: 'Beds', x: 30, y: 762, size: 4.4 },
    ]
    const { html } = await extractHTML(authorPdf([...reportRuns, ...sidebarRuns]))

    expect(htmlText(html[0]!)).toContain('Property Name\nAllaso High Desert\nBeds')
    expect(htmlRows(html[0]!).map(htmlCells)).toContainEqual(['Property', 'Beds', 'Baths', 'Units', 'Rent', 'NER'])
    expect(htmlRows(html[0]!).map(htmlCells).flat()).not.toContain('Property Name')
  })

  it('converts repeated sparse chart panels without inventing plotted values', async () => {
    const chartRuns: AuthoredRun[] = [
      { text: 'Portfolio Chart Report', x: 30, y: 820, size: 7 },
      { text: 'North', x: 120, y: 700, size: 12 },
      { text: 'South', x: 390, y: 700, size: 12 },
      { text: 'West', x: 120, y: 500, size: 12 },
      { text: 'Quoted', x: 105, y: 680, size: 4 },
      { text: 'Signed', x: 145, y: 680, size: 4 },
      { text: 'Quoted', x: 375, y: 680, size: 4 },
      { text: 'Signed', x: 415, y: 680, size: 4 },
      { text: 'Quoted', x: 105, y: 480, size: 4 },
      { text: 'Signed', x: 145, y: 480, size: 4 },
      { text: 'Alpha', x: 55, y: 540, size: 4 },
      { text: 'Beta', x: 120, y: 540, size: 4 },
      { text: 'Gamma', x: 185, y: 540, size: 4 },
      { text: 'Delta', x: 325, y: 540, size: 4 },
      { text: 'Epsilon', x: 390, y: 540, size: 4 },
      { text: 'Zeta', x: 455, y: 540, size: 4 },
      { text: 'Eta', x: 55, y: 420, size: 4 },
      { text: 'Theta', x: 120, y: 420, size: 4 },
      { text: 'Iota', x: 185, y: 420, size: 4 },
      ...Array.from({ length: 8 }, (_, index) => ({
        text: `caption ${index + 1}`,
        x: 30 + index * 45,
        y: 300,
        size: 4,
      })),
    ]
    const { html } = await extractHTML(authorPdf(chartRuns))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(3)
    expect(html[0]).toContain('<h2>North</h2>')
    expect(html[0]).toContain('<h2>South</h2>')
    expect(html[0]).toContain('<h2>West</h2>')
    expect(rows).toContainEqual(['Category', 'Quoted', 'Signed'])
    expect(rows).toContainEqual(['Alpha', '', ''])
    expect(rows).toContainEqual(['Zeta', '', ''])
  })

  it('converts a dashboard summary and each positioned chart into tables', async () => {
    const chartTitles = [
      ['Quoted vs Signed Rent by Region', 50, 700],
      ['Lease Count by Calendar Month', 350, 700],
      ['Average Rent by Floor Plan', 50, 560],
      ['Market Time by Calendar Month', 350, 560],
      ['Available Homes by Portfolio Region', 50, 420],
      ['Average Concession by Portfolio Region', 350, 420],
    ] as const
    const chartRuns: AuthoredRun[] = [
      { text: 'Leasing Dashboard', x: 30, y: 820, size: 8 },
      { text: 'Note: Chart tables contain only labels and values exposed by the source document.', x: 30, y: 790, size: 4 },
      ...['Area', 'Rent', 'Effective Rent', 'Days', 'Leases'].map((text, index) => ({
        text,
        x: 70 + index * 90,
        y: 760,
        size: 4,
      })),
      ...['950', '$1,800', '$1,750', '42', '18'].map((text, index) => ({
        text,
        x: 70 + index * 90,
        y: 744,
        size: 4,
      })),
      ...chartTitles.map(([text, x, y]) => ({ text, x, y, size: 7 })),
    ]
    for (const [title, titleX, titleY] of chartTitles) {
      const leftPanel = titleX < 200
      const categoryY = titleY - 115
      const valueY = titleY - 70
      const categoryStarts = leftPanel ? [55, 120, 185] : [345, 410, 475]
      const pairedSeries = title.includes(' vs ')
      for (const [categoryIndex, x] of categoryStarts.entries()) {
        chartRuns.push({ text: `Region ${categoryIndex + 1}`, x, y: categoryY, size: 4 })
        chartRuns.push({ text: String(10 + categoryIndex), x, y: valueY, size: 4 })
        if (pairedSeries) {
          chartRuns.push({ text: String(20 + categoryIndex), x: x + 8, y: valueY, size: 4 })
        }
      }
    }
    const { html } = await extractHTML(authorPdf(chartRuns))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(html[0]!.match(/<table>/g)).toHaveLength(7)
    expect(rows).toContainEqual(['Area', 'Rent', 'Effective Rent', 'Days', 'Leases'])
    expect(rows).toContainEqual(['950', '$1,800', '$1,750', '42', '18'])
    expect(rows).toContainEqual(['Category', 'Quoted', 'Signed Rent'])
    expect(rows).toContainEqual(['Region 1', '10', '20'])
    for (const [title] of chartTitles) {
      expect(html[0]).toContain(`<h2>${title}</h2>`)
    }
  })

  it('aligns staggered diagonal chart labels with their exposed values', async () => {
    const chartTitles = [
      ['Average Concessions (% of asking rent)', 50, 700],
      ['Average Rent by Unit Type', 350, 700],
      ['Lease Count by Calendar Month', 50, 500],
      ['Market Time by Calendar Month', 350, 500],
      ['Available Homes by Portfolio Region', 50, 300],
      ['Average Rent by Portfolio Region', 350, 300],
    ] as const
    const categories = ['Allaso High Desert', 'Olympus Latitude', 'SkyStone Apartments', 'Olympus Northpoint', 'Allaso Vineyards']
    const values = ['0.36%', '0.90%', '1.43%', '1.52%', '3.23%']
    const chartRuns: AuthoredRun[] = [
      { text: 'Leasing Dashboard', x: 30, y: 820, size: 8 },
      ...Array.from({ length: 4 }, (_, captionIndex) => ({
        text: `Dashboard note ${captionIndex + 1}`,
        x: 30 + captionIndex * 100,
        y: 780,
        size: 4,
      })),
      ...chartTitles.map(([text, x, y]) => ({ text, x, y, size: 7 })),
      ...categories.map((text, categoryIndex) => {
        const x = 75 + categoryIndex * 45
        const y = 525 + categoryIndex * 3
        return {
          text,
          x,
          y,
          size: 4,
          matrix: [0.7, 0.7, -0.7, 0.7, x, y] as AuthoredRun['matrix'],
        }
      }),
      ...values.map((text, valueIndex) => ({
        text,
        x: 75 + valueIndex * 45,
        y: 610,
        size: 4,
      })),
    ]
    const { html } = await extractHTML(authorPdf(chartRuns))
    const rows = htmlRows(html[0]!).map(htmlCells)

    for (const [categoryIndex, category] of categories.entries()) {
      expect(rows).toContainEqual([category, values[categoryIndex]!])
    }
  })

  it('recovers outlined chart labels from matching text elsewhere on the page', async () => {
    const chartTitles = [
      ['Average Concessions (% of asking rent)', 50, 700],
      ['Average Days by Property', 350, 700],
      ['Lease Count by Calendar Month', 50, 500],
      ['Market Time by Calendar Month', 350, 500],
      ['Available Homes by Portfolio Region', 50, 300],
      ['Average Rent by Portfolio Region', 350, 300],
    ] as const
    const categoryShapes = [
      { label: 'Allaso High Desert', width: 23.04, subpathCount: 25, value: '0.36%' },
      { label: 'Olympus Latitude', width: 22.24, subpathCount: 21, value: '0.90%' },
      { label: 'SkyStone Apartments', width: 27.20, subpathCount: 24, value: '1.43%' },
      { label: 'Olympus Northpoint', width: 25.92, subpathCount: 23, value: '1.52%' },
      { label: 'Allaso Vineyards', width: 20.64, subpathCount: 22, value: '3.23%' },
    ]
    const chartRuns: AuthoredRun[] = [
      { text: 'Leasing Dashboard', x: 30, y: 820, size: 8 },
      ...chartTitles.map(([text, x, y]) => ({ text, x, y, size: 7 })),
      ...categoryShapes.flatMap(({ label }, categoryIndex) => [
        { text: label, x: 335, y: 650 - categoryIndex * 20, size: 4 },
        { text: String(60 + categoryIndex), x: 510, y: 650 - categoryIndex * 20, size: 4 },
      ]),
      ...categoryShapes.map(({ value }, categoryIndex) => ({
        text: value,
        x: 70 + categoryIndex * 45,
        y: 610,
        size: 4,
      })),
    ]
    const outlinedLabels = categoryShapes.map(({ width, subpathCount }, categoryIndex) => {
      const left = 70 + categoryIndex * 45 - width / 2
      const bottom = 530
      const contours = Array.from({ length: subpathCount }, (_, contourIndex) => {
        const progress = subpathCount === 1 ? 0 : contourIndex / (subpathCount - 1)
        const x = left + progress * (width - 0.2)
        const y = bottom + progress * (width - 0.2)
        return `${x} ${y} m ${x + 0.2} ${y} l ${x + 0.2} ${y + 0.1} l ${x + 0.15} ${y + 0.2} l ${x + 0.1} ${y + 0.15} l ${x + 0.05} ${y + 0.2} l ${x} ${y + 0.1} l h`
      })
      return `${contours.join('\n')} f`
    }).join('\n')
    const { html } = await extractHTML(authorPdf(
      chartRuns,
      [],
      [`0.35 0.35 0.35 rg\n${outlinedLabels}`],
    ))
    const rows = htmlRows(html[0]!).map(htmlCells)

    for (const { label, value } of categoryShapes) {
      expect(rows).toContainEqual([label, value])
    }
  })

  it('estimates available line chart values from calibrated vector markers', async () => {
    const chartTitles = [
      ['Asking vs Effective Rent PSF By Month', 50, 700],
      ['Average Rent by Unit Type by Month', 350, 700],
      ['Lease Count by Calendar Month', 50, 500],
      ['Market Time by Calendar Month', 350, 500],
      ['Available Homes by Portfolio Region', 50, 300],
      ['Average Concessions by Portfolio Region', 350, 300],
    ] as const
    const chartRuns: AuthoredRun[] = [
      { text: 'Leasing Dashboard', x: 30, y: 820, size: 8 },
      ...chartTitles.map(([text, x, y]) => ({ text, x, y, size: 7 })),
      { text: '(closed listings)', x: 140, y: 686, size: 4 },
      { text: 'Average Asking PSF', x: 115, y: 675, size: 4 },
      { text: 'Effective Rent PSF', x: 215, y: 675, size: 4 },
      ...['$0.00', '$0.50', '$1.00', '$1.50', '$2.00', '$2.50'].map((text, tickIndex) => ({
        text,
        x: 35,
        y: 518 + tickIndex * 28,
        size: 4,
      })),
      ...['Jan', 'Feb', 'Mar', 'Apr'].map((text, monthIndex) => ({
        text,
        x: 105 + monthIndex * 45,
        y: 515,
        size: 4,
      })),
    ]
    const gridLines = Array.from({ length: 6 }, (_, tickIndex) => {
      const y = 520 + tickIndex * 28
      return `70 ${y} m 285 ${y} l S`
    }).join('\n')
    const askingValues = [1.5, undefined, 2, 1.5]
    const effectiveValues = [1.25, 1.75, 1.5, 2]
    const markerCommands = [
      '0.25 0.45 0.8 RG',
      '92 677 m 110 677 l S',
      ...askingValues.flatMap((value, valueIndex) => {
        if (value === undefined) {
          return []
        }
        const x = 107 + valueIndex * 45
        const y = 520 + value * 56
        return [`${x - 2} ${y - 2} 4 4 re S`]
      }),
      '0.2 0.15 0.75 RG',
      '192 677 m 210 677 l S',
      ...effectiveValues.map((value, valueIndex) => {
        const x = 107 + valueIndex * 45
        const y = 520 + value * 56
        return `${x - 2} ${y - 2} 4 4 re S`
      }),
    ].join('\n')
    const { html } = await extractHTML(authorPdf(
      chartRuns,
      [],
      [`0.8 G 0.5 w\n${gridLines}\n${markerCommands}`],
    ))
    const rows = htmlRows(html[0]!).map(htmlCells)

    expect(rows).toContainEqual([
      'Category',
      'Average Asking PSF (estimated)',
      'Effective Rent PSF (estimated)',
    ])
    expect(rows).toContainEqual(['Jan', '$1.50', '$1.25'])
    expect(rows).toContainEqual(['Feb', '', '$1.75'])
    expect(rows).toContainEqual(['Apr', '$1.50', '$2.00'])
  })

  it('reconstructs a filtered matrix with grouped metric bands', async () => {
    const starts = Array.from({ length: 20 }, (_, columnIndex) => 100 + columnIndex * 23)
    const header = [
      'Property',
      'Beds',
      'Baths',
      'Plan',
      'Rent',
      'NER',
      'Conc. %',
      '# Leases',
      'Rent',
      'NER',
      'Conc. %',
      '# Leases',
      'Min',
      'Avg',
      'Max',
      'Avg PSF',
      'Min',
      'Avg',
      'Max',
      'Avg PSF',
    ]
    const body = Array.from({ length: 22 }, (_, rowIndex) => [
      rowIndex === 0 ? 'Subject Property' : '',
      String(rowIndex % 3 + 1),
      String(rowIndex % 2 + 1),
      `Plan ${rowIndex + 1}`,
      ...Array.from({ length: 16 }, (_, metricIndex) =>
        metricIndex % 4 === 2
          ? `${metricIndex + rowIndex}.0%`
          : `$${1_500 + metricIndex * 10 + rowIndex}`),
    ])
    const runs = [
      { text: 'Dense Rent Matrix', x: 20, y: 820, size: 8 },
      { text: 'Report Date:', x: 470, y: 820, size: 3 },
      { text: '06/15/2026', x: 520, y: 820, size: 3 },
      { text: 'Note: Select filters at left to constrain the matrix while retaining every aligned metric column.', x: 20, y: 795, size: 3 },
      { text: 'Metric', x: 350, y: 795, size: 3 },
      { text: 'Rolling Rent', x: 390, y: 795, size: 3 },
      { text: '90', x: starts[4]!, y: 784, size: 2 },
      { text: '90-Day Trailing Rents', x: starts[4]! + 8, y: 784, size: 5 },
      { text: '30', x: starts[8]!, y: 784, size: 2 },
      { text: '30-Day Trailing Rents', x: starts[8]! + 8, y: 784, size: 5 },
      { text: 'Active Asking Rents', x: starts[12]! + 4, y: 784, size: 5 },
      { text: 'Active Effective Rents', x: starts[16]! + 4, y: 784, size: 5 },
      ...tableRuns([header, ...body], { size: 1.5, starts, top: 780 }),
      { text: 'Property Name', x: 20, y: 777, size: 2 },
      { text: 'Subject Property', x: 21, y: 774, size: 2 },
      { text: 'Comparable Property', x: 21, y: 771, size: 2 },
      { text: 'Beds', x: 20, y: 750, size: 2 },
      { text: '1', x: 21, y: 747, size: 2 },
      { text: '2', x: 21, y: 744, size: 2 },
      { text: 'Baths', x: 60, y: 750, size: 2 },
      { text: '1', x: 61, y: 747, size: 2 },
      { text: '2', x: 61, y: 744, size: 2 },
    ]
    const { html } = await extractHTML(authorPdf(runs))
    const matrix = html[0]!.split('<div class="matrix-content">', 2)[1]!
    const matrixHeader = /<thead>[\s\S]*?<\/thead>/.exec(matrix)?.[0]
    const matrixBody = /<tbody>[\s\S]*?<\/tbody>/.exec(matrix)?.[0]

    expect(html[0]).toContain('<div class="matrix-with-filters">')
    expect(html[0]).toContain('<aside class="matrix-filters">')
    expect(html[0]!.match(/<table>/g)).toHaveLength(4)
    expect(matrixHeader).toContain('<th colspan="4" scope="colgroup">90-Day Trailing Rents</th>')
    expect(matrixHeader).toContain('<th colspan="4" scope="colgroup">30-Day Trailing Rents</th>')
    expect(matrixHeader).toContain('<th colspan="4" scope="colgroup">Active Asking Rents</th>')
    expect(matrixHeader).toContain('<th colspan="4" scope="colgroup">Active Effective Rents</th>')
    expect(matrixHeader?.match(/scope="col">/g)).toHaveLength(20)
    expect(matrixBody).not.toContain('Property Name')
    expect(html[0]).toContain('<p>Metric: Rolling Rent</p>')
  })

  it('does not promote nearby multi-row labels to data columns', async () => {
    const rows = [
      ['Name', 'Jan', 'Feb', 'Mar', 'Apr', 'May'],
      ['Alpha', '10', '20', '30', '40', '50'],
      ['Beta', '11', '21', '31', '41', '51'],
      ['Total', '21', '41', '61', '81', '101'],
    ]
    const starts = [80, 150, 180, 210, 240, 270]
    const groupedHeaderRuns = [
      { text: 'Trend', x: 242.2, y: 792, size: 4 },
      { text: 'Analysis', x: 242.2, y: 786, size: 4 },
    ]
    const { html } = await extractHTML(authorPdf([
      ...groupedHeaderRuns,
      ...tableRuns(rows, { starts }),
    ]))
    const renderedRows = htmlRows(html[0]!)

    expect(htmlCells(renderedRows.at(-1)!)).toEqual(rows.at(-1))
    expect(renderedRows.at(-1)).toContain('class="summary"')
  })

  it('uses a table footer for an unlabeled final aggregate without inventing a label', async () => {
    const rows = [
      ['Description', 'Account', 'Beginning', 'Current', 'Change'],
      ['Rent', '12010-000', '10.00', '12.00', '2.00'],
      ['Fees', '12010-000', '5.00', '8.00', '3.00'],
      ['', '', '15.00', '20.00', '5.00'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows)))

    expect(html[0]).toContain('<tfoot>')
    expect(htmlCells(htmlRows(html[0]!).at(-1)!)).toEqual(['', '', '15.00', '20.00', '5.00'])
    expect(html[0]).not.toContain('scope="row">Total</th>')
  })

  it('restores detached headers and wrapped group labels without inventing text', async () => {
    const starts = [80, 230, 350, 420, 490]
    const { html } = await extractHTML(authorPdf([
      { text: 'Summary by General Ledger Account', x: 160, y: 810, size: 8 },
      { text: 'Beginning', x: starts[2]!, y: 790, size: 5 },
      { text: 'Ending', x: starts[3]!, y: 790, size: 5 },
      ...tableRuns([
        ['Grand Totals:', '', '(50.00)', '(40.00)', '10.00'],
        ['12010-000 Accounts', 'Total:', '10.00', '15.00', '5.00'],
        ['Receivable', '', '', '', ''],
        ['', 'RENT', '4.00', '7.00', '3.00'],
        ['', 'FEES', '6.00', '8.00', '2.00'],
        ['23010-000 Prepaid Rent', 'Total:', '(60.00)', '(55.00)', '5.00'],
      ], { starts, top: 765, size: 5 }),
    ]))
    const document = html[0]!
    const renderedRows = htmlRows(document)

    expect(renderedRows.map(htmlCells)).toContainEqual([
      '',
      '',
      'Beginning',
      'Ending',
      '',
    ])
    expect(document).not.toContain('Transaction Code')
    expect(document).not.toContain('>Change</th>')
    expect(renderedRows.map(htmlCells)).toContainEqual([
      '12010-000 Accounts\nReceivable',
      'Total:',
      '10.00',
      '15.00',
      '5.00',
    ])
    expect(renderedRows.find(row => htmlCells(row)[0] === 'Grand Totals:'))
      .toContain('class="summary"')
  })

  it('keeps sparse worksheet rows inside one table and leaves page furniture outside', async () => {
    const starts = [35, 260, 320, 380, 440, 500, 560]
    const worksheetRows = [
      ['', 'YTD Total', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26'],
      ['Total Collections:', '$600.00', '$100.00', '$110.00', '$120.00', '$130.00', '$140.00'],
      ['Resident Deposits', '-', '-', '-', '-', '-', '-'],
      ['Pet Deposit Applied To Charges Due', '', '', '', '', '', ''],
      ['Unclaimed Property', '', '', '', '', '', ''],
      ['Exclusions:', '', '', '', '', '', ''],
      ['Total Base:', '$600.00', '$100.00', '$110.00', '$120.00', '$130.00', '$140.00'],
      ['Adjustment', '-', '-', '-', '-', '-', '-'],
      ['Retail Base', '', '', '', '', '', ''],
      ['Retail Adjustment', '', '', '', '', '', ''],
      ['Retail Fee', '-', '-', '-', '-', '-', '-'],
      ['Prorate', '', 'No', 'No', 'No', 'No', 'No'],
      ['Retail Management Fee Due', '$0.00', '$0.00', '$0.00', '$0.00', '$0.00', '$0.00'],
    ]
    const decorativeRuns = starts.map(x => ({ text: 'a', x, y: 830, size: 3 }))
    const { html } = await extractHTML(authorPdf([
      ...decorativeRuns,
      { text: 'Management Fee Calculation', x: 35, y: 810, size: 12 },
      ...tableRuns(worksheetRows, { starts, top: 790, size: 4 }),
      { text: 'Thursday, June 11, 2026', x: starts[0]!, y: 100, size: 4 },
      { text: 'Page 1 of 1', x: starts[1]!, y: 100, size: 4 },
    ]))
    const document = html[0]!
    const renderedRows = htmlRows(document).map(htmlCells)

    expect(document.match(/<table>/g)).toHaveLength(1)
    expect(renderedRows).toContainEqual([
      'Pet Deposit Applied To Charges Due',
      '',
      '',
      '',
      '',
      '',
      '',
    ])
    expect(renderedRows).toContainEqual(['Retail Adjustment', '', '', '', '', '', ''])
    expect(renderedRows).toContainEqual(['Retail Fee', '-', '-', '-', '-', '-', '-'])
    expect(document).toContain('<p>Thursday, June 11, 2026<br>Page 1 of 1</p>')
    expect(document).not.toContain('<th scope="row">a</th>')
  })

  it('keeps prominent table labels outside headers and aligns trailing numeric values', async () => {
    const starts = [50, 150, 300, 450]
    const { html } = await extractHTML(authorPdf([
      { text: 'Bank Report', x: 50, y: 820, size: 14 },
      { text: 'First Section', x: starts[0]!, y: 790, size: 8 },
      ...tableRuns([
        ['Check Date', 'Check Number', 'Payee', 'Amount'],
        ['5/20/2026', '100', 'First Payee', '10.00'],
        ['5/21/2026', '101', 'Second Payee', '20.00'],
      ], { starts, top: 770, size: 7 }),
      { text: 'Second Section', x: starts[0]!, y: 710, size: 8 },
      ...tableRuns([
        ['Date', '', 'Notes', 'Amount'],
        ['5/20/2026', '', 'First note', '10.00'],
        ['5/21/2026', '', 'Second note', '20.00'],
        ['Difference', 'Reconciled balances', '0.00', ''],
      ], { starts, top: 690, size: 7 }),
    ]))
    const document = html[0]!
    const renderedRows = htmlRows(document).map(htmlCells)

    expect(document).toContain('<h2>First Section</h2>')
    expect(document).toContain('<h2>Second Section</h2>')
    expect(renderedRows).toContainEqual(['Check Date', 'Check Number', 'Payee', 'Amount'])
    expect(renderedRows).toContainEqual([
      'Difference',
      'Reconciled balances',
      '',
      '0.00',
    ])
  })

  it('separates sparse side notes and distant page furniture from a table', async () => {
    const starts = [50, 250, 420]
    const { html } = await extractHTML(authorPdf([
      { text: 'Account Summary', x: 50, y: 820, size: 12 },
      ...tableRuns([
        ['Beginning balance', '$100.00', '# of credits: 2'],
        ['Credits', '50.00', '# of debits: 1'],
        ['Debits', '-25.00', '# of days: 30'],
        ['Checks', '-10.00', 'Average balance: $110.00'],
        ['Fees', '-0.00', ''],
        ['Ending balance', '$115.00', ''],
      ], { starts, top: 790, size: 6 }),
      { text: 'Print control values', x: starts[0]!, y: 100, size: 5 },
      { text: '1 of 4', x: starts[1]!, y: 100, size: 5 },
    ]))
    const document = html[0]!
    const renderedRows = htmlRows(document).map(htmlCells)

    expect(renderedRows).toContainEqual(['Beginning balance', '$100.00'])
    expect(renderedRows).toContainEqual(['Ending balance', '$115.00'])
    expect(document).toContain('<aside>')
    expect(document).toContain('<p># of credits: 2</p>')
    expect(document).toContain('<p>Average balance: $110.00</p>')
    expect(document).toContain('<p>Print control values<br>1 of 4</p>')
    expect(renderedRows.flat()).not.toContain('Print control values')
  })

  it('escapes HTML-sensitive text without changing its value', async () => {
    const rows = [
      ['Name', 'Path', 'Amount', 'Count'],
      ['A|B', 'C:\\temp', '<$10>', '2'],
      ['C|D', 'D:\\work', 'Tea & coffee', '3'],
    ]
    const { html } = await extractHTML(authorPdf(tableRuns(rows, {
      size: 8,
      starts: [50, 180, 320, 430],
    })))

    const renderedRows = htmlRows(html[0]!).map(htmlCells)
    expect(renderedRows).toContainEqual(rows[1])
    expect(renderedRows).toContainEqual(rows[2])
    expect(html[0]).toContain('&lt;$10&gt;')
    expect(html[0]).toContain('Tea &amp; coffee')
  })

  it('does not turn aligned prose into a table', async () => {
    const lines = [
      ['The', 'quick', 'brown', 'fox', 'arrived'],
      ['A', 'quiet', 'summer', 'rain', 'followed'],
      ['Then', 'every', 'small', 'bird', 'sang'],
    ]
    const runs = lines.flatMap((words, lineIndex) => {
      let x = 57
      return words.map((text) => {
        const run = { text, x, y: 780 - lineIndex * 14, size: 10 }
        x += text.length * 5.5 + 3
        return run
      })
    })
    const { html } = await extractHTML(authorPdf(runs))

    expect(html[0]).not.toContain('<table>')
    expect(html[0]).toContain('The quick brown fox arrived')
  })

  it('folds sparse continuation lines into their wide table record', async () => {
    const headers = [
      'Group',
      'Name',
      'Type',
      'Property',
      'Date',
      'Description',
      'Batch',
      'Status',
      'Invoice',
      'Current',
      'Control',
      'Account',
      'Aged',
      'Future',
      'Amount',
      'Notes',
    ]
    const primaryRecord = [
      'A',
      'Vendor A',
      'One',
      'P1',
      '05/14/2026',
      'First line',
      '10',
      'Open',
      '500',
      '10.00',
      'P-',
      '5000 Printing',
      '1.00',
      '2.00',
      '10.00 Memo',
      '',
    ]
    const continuation = Array.from<string>({ length: headers.length }).fill('')
    continuation[5] = 'continued'
    continuation[10] = '2401'
    continuation[11] = 'Costs'
    const followingRecords = ['B', 'C'].map((label, recordIndex) => {
      const record = [...primaryRecord]
      record[0] = label
      record[14] = `${recordIndex + 2}0.00`
      record[15] = ''
      return record
    })
    const rows = [headers, primaryRecord, continuation, ...followingRecords]
    const starts = headers.map((_, columnIndex) => 20 + columnIndex * 36)
    const baselines = [780, 774, 771, 765, 759]
    const runs = rows.flatMap((row, rowIndex) => row.flatMap((text, columnIndex) =>
      text ? [{ text, x: starts[columnIndex]!, y: baselines[rowIndex]!, size: 3 }] : []))
    const { html } = await extractHTML(authorPdf(runs))
    const renderedRows = htmlRows(html[0]!).map(htmlCells)

    expect(renderedRows).toContainEqual([
      ...primaryRecord.slice(0, 5),
      'First line\ncontinued',
      ...primaryRecord.slice(6, 10),
      'P-\n2401',
      '5000 Printing\nCosts',
      ...primaryRecord.slice(12, 14),
      '10.00',
      'Memo',
    ])
  })

  it('round-trips randomized wide tables without fusing cells', async () => {
    for (let seed = 1; seed <= 24; seed++) {
      const random = mulberry32(seed)
      const columnCount = 4 + Math.floor(random() * 13)
      const rowCount = 2 + Math.floor(random() * 10)
      const size = 3 + Math.floor(random() * 5)
      const headers = Array.from({ length: columnCount }, (_, index) => `C${String.fromCharCode(65 + index)}`)
      const rows = Array.from({ length: rowCount }, (_, rowIndex) =>
        headers.map((_, columnIndex) => `${rowIndex + 1}${String(columnIndex).padStart(2, '0')}`))
      const starts = headers.map((_, index) => 40 + index * size * 4)
      const { html } = await extractHTML(authorPdf(tableRuns(
        [headers, ...rows],
        { size, starts },
      )))
      const renderedRows = htmlRows(html[0]!)

      for (const [rowIndex, expected] of rows.entries()) {
        expect(htmlCells(renderedRows[rowIndex + 1]!), `seed ${seed} row ${rowIndex + 1}`)
          .toEqual(expected)
      }
    }
  })
})
