import { readFile, writeFile } from 'node:fs/promises'
/* eslint-disable ts/ban-ts-comment */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  definePDFJSModule,
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
    'superscript.pdf',
    'mixed-layout.pdf',
    'mixed-layout-rotate90.pdf',
    'mixed-layout-rotate180.pdf',
    'mixed-layout-rotate270.pdf',
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
