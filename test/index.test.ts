import { readFile, writeFile } from 'node:fs/promises'
/* eslint-disable ts/ban-ts-comment */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  definePDFJSModule,
  extractHTML,
  extractImages,
  extractLinks,
  extractText,
  extractTextItems,
  extractTextPages,
  getDocumentProxy,
  getMeta,
  getResolvedPDFJS,
  renderPageAsImage,
} from '../src/index'

const fixturesDir = fileURLToPath(new URL('fixtures', import.meta.url))

describe('punpdf', () => {
  it('can resolve a custom PDF.js version', async () => {
    // @ts-ignore: Dynamic import from package build
    await definePDFJSModule(() => import('../dist/pdfjs'))
    const { text } = await extractText(await getPDF())

    expect(text[0]).toMatchInlineSnapshot('"Dummy PDF file"')
  })

  it('provides the PDF.js module', async () => {
    const PDFJS = await getResolvedPDFJS()
    const { version } = PDFJS

    expect(version).toMatchInlineSnapshot(`"5.6.205"`)
  })

  it('extracts metadata from a PDF', async () => {
    const { info, metadata } = await getMeta(await getPDF())

    expect(Object.keys(metadata).length).toEqual(0)
    expect(info).toMatchInlineSnapshot(`
      {
        "Author": "Evangelos Vlachogiannis",
        "CreationDate": "D:20070223175637+02'00'",
        "Creator": "Writer",
        "EncryptFilterName": null,
        "IsAcroFormPresent": false,
        "IsCollectionPresent": false,
        "IsLinearized": false,
        "IsSignaturesPresent": false,
        "IsXFAPresent": false,
        "Language": null,
        "PDFFormatVersion": "1.4",
        "Producer": "OpenOffice.org 2.1",
      }
    `)
  })

  it('extracts text from a PDF', async () => {
    const { text, totalPages } = await extractText(await getPDF())

    expect(text[0]).toMatchInlineSnapshot('"Dummy PDF file"')
    expect(totalPages).toMatchInlineSnapshot('1')
  })

  it('extracts escaped PDF literal characters', async () => {
    const { text } = await extractText(await getPDF('escaped-pdf-literals.pdf'))

    expect(text[0]).toBe('Fixture literals\nForecast (draft)\nArchive \\ Reports')
  })

  it('extracts text in visual reading order', async () => {
    const { text } = await extractText(await getPDF('links.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toMatch(/^Links in PDF/)
    expect(text[0]).toMatch(/Antenna House, Inc\.$/)
  })

  it('streams text one page at a time', async () => {
    const pages = []

    for await (const page of extractTextPages(await getPDF('links.pdf'), {
      readingOrder: 'visual',
    })) {
      pages.push(page)
    }

    expect(pages).toHaveLength(2)
    expect(pages.map(page => page.pageNumber)).toEqual([1, 2])
    expect(pages.every(page => page.totalPages === 2)).toBe(true)
    expect(pages[0]!.text).toMatch(/^Links in PDF/)
    expect(pages[1]!.text).toMatch(/Antenna House, Inc\.$/)
  })

  for (const fixture of [
    'sample.pdf',
    'links.pdf',
    'pdflatex-image.pdf',
    'two-column.pdf',
    'table.pdf',
    'w3c-table.pdf',
    'superscript.pdf',
    'mixed-layout.pdf',
    'mixed-layout-rotate90.pdf',
    'mixed-layout-rotate180.pdf',
    'mixed-layout-rotate270.pdf',
    'sideways-table.pdf',
  ]) {
    it(`preserves every non-whitespace character of ${fixture} in visual reading order`, async () => {
      const contentOrder = await extractText(await getPDF(fixture))
      const visualOrder = await extractText(await getPDF(fixture), {
        readingOrder: 'visual',
      })

      const contentCharacters = [...contentOrder.text.join('').replace(/\s/g, '')].sort()
      const visualCharacters = [...visualOrder.text.join('').replace(/\s/g, '')].sort()
      expect(visualCharacters).toEqual(contentCharacters)
    })
  }

  it('reads two-column pages column by column in visual reading order', async () => {
    const { text } = await extractText(await getPDF('two-column.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe(
      'Two Column Sample\n'
      + 'The left column begins the story\n'
      + 'and continues along its own flow\n'
      + 'of narrow measured lines that fill\n'
      + 'the first of the two columns.\n'
      + 'The right column tells another\n'
      + 'story entirely and must not be\n'
      + 'interleaved with the left column\n'
      + 'when read in visual order.',
    )
  })

  it('separates table cells with tabs in visual reading order', async () => {
    const { text } = await extractText(await getPDF('table.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe(
      'Invoice\n'
      + 'Item\tQty\tPrice\n'
      + 'Demolition\t2\t450.00\n'
      + 'Framing\t5\t1200.00\n'
      + 'Painting\t3\t300.00',
    )
  })

  it('keeps W3C table results on the same line as their row labels', async () => {
    const { text } = await extractText(await getPDF('w3c-table.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toContain('Blind\t5\t1\t4\t34.5%, n=1\t1199 sec, n=1')
    expect(text[0]).toContain('Mobility\t3\t3\t0\t95.4%, n=3\t1416 sec, n=3')
  })

  it('keeps superscripts and subscripts inline in visual reading order', async () => {
    const { text } = await extractText(await getPDF('superscript.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe('E=mc2\nH2O')
  })

  it('reads a mixed layout page the way a person would', async () => {
    const { text } = await extractText(await getPDF('mixed-layout.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe(
      'Quarterly Review\n'
      + 'Revenue grew steadily across all regions\n'
      + 'with costs held flat for the quarter.\n'
      + 'North\t120.00\n'
      + 'South\t98.50\n'
      + 'East\t210.75\n'
      + 'Alpha reports strong\n'
      + 'engagement in the north\n'
      + 'while retention holds\n'
      + 'above expectations.\n'
      + 'Beta launches next\n'
      + 'quarter with pricing\n'
      + 'still under internal\n'
      + 'review by finance.\n'
      + 'Page 1 of 1',
    )
  })

  // shadow-text.pdf is deliberately absent from the conservation loop above:
  // visual order drops duplicated draws that content order keeps.
  it('keeps one copy of text drawn twice at the same position', async () => {
    const { text } = await extractText(await getPDF('shadow-text.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe('36 Financial Stability Report')
  })

  it('reads a sideways table on an upright page without joining its cells', async () => {
    const { text } = await extractText(await getPDF('sideways-table.pdf'), {
      readingOrder: 'visual',
    })

    expect(text[0]).toBe(
      'Portfolio Summary\n'
      + '$1,947\t$1,930\t$1,842\n'
      + '$2,006\t$1,999\t$1,921\n'
      + '$2.31\t$2.23\t$2.18',
    )
  })

  it('reads identically at every page rotation', async () => {
    const upright = await extractText(await getPDF('mixed-layout.pdf'), {
      readingOrder: 'visual',
    })

    for (const rotation of [90, 180, 270]) {
      const rotated = await extractText(
        await getPDF(`mixed-layout-rotate${rotation}.pdf`),
        { readingOrder: 'visual' },
      )
      expect(rotated.text, `rotation ${rotation}`).toEqual(upright.text)
    }
  })

  it('keeps line structure when merging pages in visual reading order', async () => {
    const { text } = await extractText(await getPDF('links.pdf'), {
      mergePages: true,
      readingOrder: 'visual',
    })

    expect(text).toContain('Links in PDF\n')
    expect(text).toContain('\n\nAbout Antenna House')
  })

  it('extracts visually detected tables as HTML', async () => {
    const { html, totalPages } = await extractHTML(await getPDF('table.pdf'))

    expect(totalPages).toBe(1)
    expect(html[0]).toContain('<h1>Invoice</h1>')
    expect(html[0]).toContain('<thead>')
    expect(html[0]).toContain('<th scope="col">Item</th>')
    expect(html[0]).toContain('<tr><th scope="row">Demolition</th><td>2</td><td>450.00</td></tr>')
  })

  it('generates column labels for a data-only table', async () => {
    const { html } = await extractHTML(await getPDF('sideways-table.pdf'))

    expect(html[0]).toContain('<th scope="col">Row label</th>')
    expect(html[0]).toContain('<th scope="col">Column 2</th>')
    expect(html[0]).toContain('<tr><th scope="row">$1,947</th><td>$1,930</td><td>$1,842</td></tr>')
  })

  it('marks page boundaries when merging HTML', async () => {
    const { html } = await extractHTML(await getPDF('links.pdf'), {
      mergePages: true,
    })

    expect(html).toContain('<hr class="page-break">')
    expect(html).toContain('<article class="pdf-page" data-page-number="2">')
    expect(html).toContain('<h1>About Antenna House</h1>')
  })

  it('does not carry a report title into an independent table page', async () => {
    const { html } = await extractHTML(await getPDF('independent-table-pages.pdf'))

    expect(html[1]).not.toContain('Legal and Other Contingencies (continued)')
    expect(html[1]).toContain('CONSOLIDATED STATEMENTS OF OPERATIONS')
    expect(html[1]).toContain('Net sales')
  })

  it('does not inherit a prior header into a locally captioned table', async () => {
    const { html } = await extractHTML(await getPDF('local-table-caption.pdf'))

    expect(html[1]).toContain('Table 11b. Local assets and liabilities')
    expect(html[1]).toContain('Cash')
    expect(html[1]).not.toContain('Legacy category')
    expect(html[1]).not.toContain('Legacy current')
  })

  it('does not promote a lowercase table-header fragment to a page title', async () => {
    const { html } = await extractHTML(await getPDF('lowercase-table-caption.pdf'))

    expect(html[0]).toContain('reporting date using')
    expect(html[0]).not.toContain('<h1>reporting date using</h1>')
  })

  it('keeps every column when a financial table header precedes its section label', async () => {
    const { html } = await extractHTML(await getPDF('detached-financial-table-header.pdf'))

    expect(html[0]).toContain('<tr><th scope="col">Row label</th><th scope="col">Note</th><th scope="col">Current</th><th scope="col">Prior</th></tr>')
    expect(html[0]).toContain('<tr><th scope="row">Cash</th><td>3</td><td>120</td><td>110</td></tr>')
    expect(html[0]).toContain('<tr><th scope="row">Investments</th><td>4</td><td>240</td><td>220</td></tr>')
  })

  it('keeps every column beneath a stacked financial table header', async () => {
    const { html } = await extractHTML(await getPDF('detached-financial-table-header.pdf'))

    expect(html[1]).toContain('<tr><th scope="col">Row label</th><th scope="col">Operating assets<br>Cash</th><th scope="col">Securities</th><th scope="col">Total assets<br>Total</th></tr>')
    expect(html[1]).toContain('<tr><th scope="row">Opening balance</th><td>120</td><td>240</td><td>360</td></tr>')
    expect(html[1]).toContain('<tr><th scope="row">Closing balance</th><td>130</td><td>260</td><td>390</td></tr>')
  })

  it('keeps the first text-only financial record in the table body', async () => {
    const { html } = await extractHTML(await getPDF('financial-record-after-header.pdf'))

    expect(html[0]).toContain('<th scope="col">As at year end</th>')
    expect(html[0]).toContain('<tr><th scope="row">with partner banks<br>Central Bank A</th><td>Dollars</td><td>No expiry</td><td>Unlimited</td></tr>')
    expect(html[0]).toContain('<tr><th scope="row">Central Bank B</th><td>Euros</td><td>Annual</td><td>500</td></tr>')
  })

  it('does not merge an independently headed financial table into the preceding table', async () => {
    const { html } = await extractHTML(await getPDF('independent-financial-table.pdf'))

    expect(html[0]!.match(/<table>/g)).toHaveLength(2)
    expect(html[0]).toContain('<th scope="col">Total</th>')
    expect(html[0]).toContain('<tr><th scope="row">Government bonds</th><td>120</td><td>125</td><td>245</td></tr>')
  })

  it('keeps the first record in a headerless financial table section', async () => {
    const { html } = await extractHTML(await getPDF('headerless-financial-section.pdf'))

    expect(html[0]).toContain('North America Commercial')
    expect(html[0]).toContain('8,172')
    expect(html[0]).toContain('5,713')
    expect(html[0]).toContain('824')
    expect(html[0]).toContain('1,087')
    expect(html[0]).toContain('8,452')
  })

  it('structures a dense parallel financial table with row and column labels', async () => {
    const { html } = await extractHTML(await getPDF('dense-parallel-financial-table.pdf'))

    expect(html[0]!.match(/<table>/g)).toHaveLength(1)
    expect(html[0]!.match(/<th scope="col">/g)).toHaveLength(3)
    expect(html[0]).toContain('<th scope="col">Subsidiaries</th>')
    expect(html[0]).toContain('<th scope="row">Left subsidiary 01</th><td>100.00</td><td>12</td>')
    expect(html[0]).toContain('<tr><th scope="row">Right subsidiary 40</th><td>100.00</td><td>24</td></tr>')
    expect(html[0]).not.toContain('<figure class="spatial-content">')
  })

  it('structures placeholder financial records that follow a wrapped header', async () => {
    const { html } = await extractHTML(await getPDF('placeholder-financial-records.pdf'))

    expect(html[0]!.match(/<th scope="col">/g)).toHaveLength(9)
    expect(html[0]).toContain('<th scope="row">Supervisory function</th><td>-</td>')
    expect(html[0]).toContain('<th scope="row">Management function</th><td>58.9</td><td>4.1</td><td>4.2</td><td>1.9</td><td>48.7</td>')
    expect(html[0]).not.toContain('<figure class="spatial-content">')
  })

  it('joins a wrapped financial row label without dropping its trailing value', async () => {
    const { html } = await extractHTML(await getPDF('wrapped-financial-row.pdf'))

    expect(html[0]).toContain('<tr><th scope="row">31 December</th><td>120</td><td>105</td></tr>')
  })

  it('does not promote continuation footer furniture to a page title', async () => {
    const { html } = await extractHTML(await getPDF('continued-footer.pdf'))

    expect(html[0]).toContain('Continued')
    expect(html[0]).not.toContain('<h1>Continued</h1>')
  })

  it('preserves source ordinals when legal sections are separate lists', async () => {
    const { html } = await extractHTML(await getPDF('legal-sections.pdf'))

    expect(html[0]).toContain('<ol start="5">')
    expect(html[0]).toContain('<ol start="6">')
    expect(html[0]).toContain('<ol start="7">')
    expect(html[0]).toContain('<li>Dividend and Voting Rights.</li>')
  })

  it('uses spatial markup for a word-fragmented financial grid', async () => {
    const { html } = await extractHTML(await getPDF('fragmented-financial-table.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/Treasury\s+securities/)
    expect(html[0]).not.toContain('<table>')
  })

  it('uses positioned spatial markup for a fragmented compact schedule', async () => {
    const { html } = await extractHTML(await getPDF('compact-schedule.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/1st\s+December 1/)
    expect(html[0]).toMatch(/4th\s+September 1/)
    expect(html[0]).not.toContain('<table>')
  })

  it('uses spatial markup when financial labels detach from their values', async () => {
    const { html } = await extractHTML(await getPDF('detached-financial-labels.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toContain('Cash')
    expect(html[0]).toMatch(/800\s+800\s+800/)
  })

  it('keeps detached exhibit identifiers aligned with their rows', async () => {
    const { html } = await extractHTML(await getPDF('detached-exhibit-identifiers.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/4\.10\s+Officer Certificate\s+8-K 4\.1\s+2\/23\/16/)
    expect(html[0]).toMatch(/4\.16\s+Officer Certificate\s+8-K 4\.1\s+2\/29\/16/)
  })

  it('keeps signature names, roles, and dates on the same row', async () => {
    const { html } = await extractHTML(await getPDF('fragmented-signatures.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/\/s\/ Alex Example\s+Chief Executive Officer\s+November 1 2024/)
    expect(html[0]).toMatch(/\/s\/ Casey Example\s+Director\s+November 1 2024/)
  })

  it('groups detached bullet markers with their entries', async () => {
    const { html } = await extractHTML(await getPDF('detached-bullets.pdf'))

    expect(html[0]).toContain('<ul>')
    expect(html[0]).toContain('<li>Purchases under the employee stock plan are permitted</li>')
    expect(html[0]).not.toMatch(/<h[1-6]>[-•*]<\/h[1-6]>/)
  })

  it('does not treat a calendar year at a paragraph boundary as a list item', async () => {
    const { html } = await extractHTML(await getPDF('calendar-year-continuation.pdf'))

    expect(html[0]).toContain('2024. At June 30 2024 remittances remained suspended.')
    expect(html[0]).not.toContain('<ol start="2024">')
  })

  it('does not leak Markdown emphasis around a wrapped summary cell', async () => {
    const { html } = await extractHTML(await getPDF('wrapped-summary.pdf'))

    expect(html[0]).toContain('<strong>Total net sales</strong>')
    expect(html[0]).not.toContain('<strong>$<br>2024</strong>')
    expect(html[0]).not.toContain('**')
  })

  it('reads aligned narrative columns from top to bottom', async () => {
    const { html } = await extractHTML(await getPDF('aligned-narrative-columns.pdf'))

    expect(html[0]).not.toContain('<table>')
    expect(html[0]).toContain('The final left paragraph completes its own argument.')
    expect(html[0]).toContain('The right column begins an independent policy section')
    expect(html[0]!.indexOf('The final left paragraph')).toBeLessThan(
      html[0]!.indexOf('The right column begins'),
    )
  })

  it('preserves a narrative grid after a labeled table', async () => {
    const { html } = await extractHTML(await getPDF('narrative-grid-after-table.pdf'))

    expect(html[0]).toContain('Details')
    expect(html[0]).toContain('Regional reach')
    expect(html[0]).toContain('Teams serve customers across several markets')
    expect(html[0]).toContain('Four groups coordinate the operating programme')
    expect(html[0]).toContain('The programme continues in the following section.')
    expect(html[1]).toContain('Service scope')
    expect(html[1]).toContain('Advisers cover commercial accounts')
    expect(html[1]).toContain('Teams report progress every quarter')
  })

  it('uses spatial markup for fragmented parallel narrative sections', async () => {
    const { html } = await extractHTML(await getPDF('fragmented-parallel-narrative.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/The first left paragraph introduces operating policy\s+The first right paragraph introduces funding policy/)
    expect(html[0]).toContain('Both policy discussions finish on their own terms')
    expect(html[0]).not.toContain('<table>')
  })

  it('removes repeated page navigation from a merged report', async () => {
    const { html } = await extractHTML(await getPDF('repeated-page-navigation.pdf'), {
      mergePages: true,
    })

    expect(html).toContain('Chair report')
    expect(html).toContain('Financial review')
    expect(html).toContain('Funding appendix')
    expect(html).toContain('<figure class="spatial-content"><pre>')
    expect(html).not.toContain('Overview')
    expect(html).not.toContain('Operations')
    expect(html).not.toContain('Financial statements')
    expect(html).not.toContain('Appendices')
  })

  it('uses spatial markup when a narrative sidebar overlaps a table', async () => {
    const { html } = await extractHTML(await getPDF('table-with-sidebar.pdf'))

    expect(html[0]).toContain('<figure class="spatial-content"><pre>')
    expect(html[0]).toMatch(/Alex North\s+Controller\s+Example One\s+30 June 2026/)
    expect(html[0]).toContain('Observer organisations')
    expect(html[0]).not.toContain('<table>')
  })

  it('repairs repeated misdecoded checkmark bullets', async () => {
    const { html } = await extractHTML(await getPDF('misdecoded-checkmarks.pdf'))

    expect(html[0]).toContain('✓ Use measurable performance goals')
    expect(html[0]).toContain('X Promise automatic payouts')
    expect(html[0]).not.toContain('ü')
  })

  it('can preserve the rendered page beside extracted semantic content', async () => {
    const { html } = await extractHTML(await getPDF('pdflatex-image.pdf'), {
      preserveLayout: {
        canvasImport: () => import('@napi-rs/canvas'),
        scale: 0.5,
      },
    })

    expect(html[0]).toContain('<figure class="pdf-page-render"><img alt="" src="data:image/png;base64,')
    expect(html[0]).toContain('<article class="pdf-page" data-page-number="1">')
  })

  it('preserves layout without taking ownership of a PDF document proxy', async () => {
    const pdf = await getDocumentProxy(await getPDF('pdflatex-image.pdf'))

    try {
      const { html } = await extractHTML(pdf, {
        mergePages: true,
        preserveLayout: {
          canvasImport: () => import('@napi-rs/canvas'),
          scale: 0.25,
        },
      })

      expect(html).toContain('<figure class="pdf-page-render"><img alt="" src="data:image/png;base64,')
      expect((await pdf.getMetadata()).info).toBeDefined()
    }
    finally {
      await pdf.destroy()
    }
  })

  it('extracts structured text items from a PDF', async () => {
    const { items, totalPages } = await extractTextItems(await getPDF())

    expect(totalPages).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]!.length).toBeGreaterThan(0)

    const firstItem = items[0]![0]!
    expect(firstItem).toMatchInlineSnapshot(`
      {
        "dir": "ltr",
        "fontFamily": "sans-serif",
        "fontKey": "font-1",
        "fontSize": 16.1,
        "hasEOL": false,
        "height": 16.1,
        "str": "Dummy PDF file",
        "width": 123.41130000000003,
        "x": 56.8,
        "y": 758.1,
      }
    `)
  })

  it('extracts links from a PDF', async () => {
    const { links, totalPages } = await extractLinks(await getPDF('links.pdf'))
    expect(links.length).toMatchInlineSnapshot('4')
    expect(links[0]).toMatchInlineSnapshot('"https://www.antennahouse.com/"')
    expect(totalPages).toMatchInlineSnapshot('2')
  })

  it('extracts images from a PDF', async () => {
    const [firstImage] = await extractImages(await getPDF('pdflatex-image.pdf'), 1)
    expect(firstImage!.key).toMatchInlineSnapshot('"img_p0_1"')
  })

  it('renders a PDF as image', async () => {
    const result = await renderPageAsImage(await getPDF('pdflatex-image.pdf'), 1, {
      canvasImport: () => import('@napi-rs/canvas'),
    })

    await writeFile(
      new URL('artifacts/pdflatex-image.png', import.meta.url),
      new Uint8Array(result),
    )

    // Verify the buffer contains PNG header signature (first 8 bytes of a PNG file)
    const headerBytes = new Uint8Array(result, 0, 8)
    expect(Array.from(headerBytes)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('renders a PDF as data URL', async () => {
    const result = await renderPageAsImage(await getPDF('pdflatex-image.pdf'), 1, {
      canvasImport: () => import('@napi-rs/canvas'),
      toDataURL: true,
    })

    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDFLatex Image</title>
  </head>
  <body>
    <img alt="Image" src="${result}">
  </body>
</html>`
    await writeFile(
      new URL('artifacts/pdflatex-image.html', import.meta.url),
      html,
    )

    expect(result.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('supports passing PDFDocumentProxy', async () => {
    const pdf = await getDocumentProxy(await getPDF())
    const { info } = await getMeta(pdf)

    expect(info.Creator).toMatchInlineSnapshot('"Writer"')
  })

  it('parses PDF dates when parseDates option is enabled', async () => {
    // Test basic date parsing from /Info dictionary
    const { info: infoWithDates } = await getMeta(await getPDF(), { parseDates: true })

    expect(infoWithDates.ModDate).toBeUndefined() // ModDate not present in sample.pdf
    expect(infoWithDates.CreationDate).toBeInstanceOf(Date)
    expect(infoWithDates.CreationDate.getFullYear()).toBe(2007)

    // Test XMP metadata date parsing
    const { info: infoLinks, metadata: linksMetadata } = await getMeta(
      await getDocumentProxy(await getPDF('links.pdf')),
      { parseDates: true },
    )

    // Verify /Info dates are parsed
    expect(infoLinks.CreationDate).toBeInstanceOf(Date)
    expect(infoLinks.ModDate).toBeInstanceOf(Date)
    expect(infoLinks.CreationDate.getFullYear()).toBe(2024)
    expect(infoLinks.ModDate.getFullYear()).toBe(2024)

    // Verify XMP dates are parsed
    expect(linksMetadata.get('xmp:createdate')).toBeInstanceOf(Date)
    expect(linksMetadata.get('xmp:modifydate')).toBeInstanceOf(Date)
    expect(linksMetadata.get('xmp:metadatadate')).toBeInstanceOf(Date)
    expect(linksMetadata.get('xmp:createdate').getFullYear()).toBe(2024)

    expect(linksMetadata.get('xap:createdate')).toBeNull()
    expect(linksMetadata.get('xap:modifydate')).toBeNull()
    expect(linksMetadata.get('xap:metadatadate')).toBeNull()
  })
})

async function getPDF(filename = 'sample.pdf') {
  const pdf = await readFile(join(fixturesDir, filename))
  return new Uint8Array(pdf)
}
