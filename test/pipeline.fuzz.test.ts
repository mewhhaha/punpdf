/* eslint-disable ts/ban-ts-comment */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  definePDFJSModule,
  extractLinks,
  extractText,
  extractTextItems,
  extractTextPages,
  getMeta,
  getResolvedPDFJS,
} from '../src/index'

beforeAll(async () => {
  // @ts-ignore: Dynamic import from package build
  await definePDFJSModule(() => import('../dist/pdfjs'))
})

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomToken(random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW0123456789'
  const length = 2 + Math.floor(random() * 7)
  let token = ''
  for (let index = 0; index < length; index++) {
    token += alphabet.charAt(Math.floor(random() * alphabet.length))
  }
  return token
}

interface AuthoredRun {
  text: string
  x: number
  y: number
  size: number
}

interface AuthoredPage {
  runs: AuthoredRun[]
  links?: string[]
}

interface AuthoredDocument {
  pages: AuthoredPage[]
  info?: Record<string, string>
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// Minimal single-font PDF writer, kept independent of the fixture generator
// so fuzzing can grow document features without disturbing fixture bytes.
function authorPdf({ pages, info }: AuthoredDocument): Uint8Array {
  let nextId = 3
  const pageLayouts = pages.map(page => ({
    page,
    pageId: nextId++,
    contentId: nextId++,
    annotationIds: (page.links ?? []).map(() => nextId++),
  }))
  const fontId = nextId++
  const infoId = info ? nextId++ : undefined

  const objects: Array<{ id: number, body: string }> = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pageLayouts.map(layout => `${layout.pageId} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    },
  ]

  for (const { page, pageId, contentId, annotationIds } of pageLayouts) {
    const annotations = annotationIds.length > 0
      ? ` /Annots [${annotationIds.map(id => `${id} 0 R`).join(' ')}]`
      : ''
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >>${annotations} /Contents ${contentId} 0 R >>`,
    })
    const content = page.runs
      .map(({ text, x, y, size }) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdfString(text)}) Tj ET`)
      .join('\n')
    objects.push({
      id: contentId,
      body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    })
    for (const [linkIndex, url] of (page.links ?? []).entries()) {
      objects.push({
        id: annotationIds[linkIndex]!,
        body: `<< /Type /Annot /Subtype /Link /Rect [50 ${700 - linkIndex * 20} 150 ${712 - linkIndex * 20}] /Border [0 0 0] /A << /S /URI /URI (${escapePdfString(url)}) >> >>`,
      })
    }
  }
  objects.push({ id: fontId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' })
  if (info && infoId) {
    const entries = Object.entries(info)
      .map(([key, value]) => `/${key} (${escapePdfString(value)})`)
      .join(' ')
    objects.push({ id: infoId, body: `<< ${entries} >>` })
  }

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const { id, body } of objects) {
    offsets.push(pdf.length)
    pdf += `${id} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  const trailerInfo = infoId ? ` /Info ${infoId} 0 R` : ''
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerInfo} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

// Cursor advance uses the widest Helvetica glyph (0.944 em) so the true
// rendered gap between tokens is always at least the planned gap.
const WIDEST_GLYPH_EM = 0.95

interface FuzzedDocument {
  bytes: Uint8Array
  pageTokens: string[][]
  links: string[]
  info: Record<string, string>
}

function fuzzedDocument(random: () => number): FuzzedDocument {
  const pageCount = 1 + Math.floor(random() * 3)
  const pageTokens: string[][] = []
  const links: string[] = []
  const pages: AuthoredPage[] = []

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const size = 8 + Math.floor(random() * 9)
    const tokens: string[] = []
    const runs: AuthoredRun[] = []
    const lineCount = 1 + Math.floor(random() * 5)
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const y = 780 - lineIndex * size * 1.6
      let x = 57
      const tokensInLine = 1 + Math.floor(random() * 3)
      for (let tokenIndex = 0; tokenIndex < tokensInLine; tokenIndex++) {
        const token = randomToken(random)
        runs.push({ text: token, x, y, size })
        tokens.push(token)
        x += token.length * size * WIDEST_GLYPH_EM + (0.6 + random()) * size
      }
    }

    const pageLinks = Array.from(
      { length: Math.floor(random() * 3) },
      () => `https://example.com/${randomToken(random)}`,
    )
    links.push(...pageLinks)
    pageTokens.push(tokens)
    pages.push({ runs, links: pageLinks })
  }

  const info = {
    Title: `Fuzz (report) \\ ${randomToken(random)}`,
    Author: `Author (${randomToken(random)})`,
  }
  return { bytes: authorPdf({ pages, info }), pageTokens, links, info }
}

function tokensOf(text: string): string[] {
  return text.split(/\s+/).filter(token => token.length > 0).sort()
}

describe('pipeline fuzzing', () => {
  it('round-trips fuzzed documents through every extraction surface', async () => {
    for (let seed = 1; seed <= 24; seed++) {
      const random = mulberry32(seed)
      const document = fuzzedDocument(random)
      const label = `seed ${seed}`

      const visual = await extractText(document.bytes.slice(), { readingOrder: 'visual' })
      expect(visual.totalPages, label).toBe(document.pageTokens.length)
      for (const [pageIndex, tokens] of document.pageTokens.entries()) {
        expect(tokensOf(visual.text[pageIndex]!), `${label} page ${pageIndex + 1} visual`)
          .toEqual([...tokens].sort())
      }

      const content = await extractText(document.bytes.slice())
      for (const [pageIndex, tokens] of document.pageTokens.entries()) {
        expect(tokensOf(content.text[pageIndex]!), `${label} page ${pageIndex + 1} content`)
          .toEqual([...tokens].sort())
      }

      const merged = await extractText(document.bytes.slice(), {
        readingOrder: 'visual',
        mergePages: true,
      })
      expect(merged.text, `${label} merged`).toBe(visual.text.join('\n\n'))

      const streamed: string[] = []
      for await (const page of extractTextPages(document.bytes.slice(), { readingOrder: 'visual' })) {
        expect(page.pageNumber, `${label} stream order`).toBe(streamed.length + 1)
        expect(page.totalPages, label).toBe(document.pageTokens.length)
        streamed.push(page.text)
      }
      expect(streamed, `${label} streamed`).toEqual(visual.text)

      const { items, totalPages } = await extractTextItems(document.bytes.slice())
      expect(totalPages, label).toBe(document.pageTokens.length)
      for (const [pageIndex, tokens] of document.pageTokens.entries()) {
        const visibleCharacters = (value: string) => [...value.replace(/\s/g, '')].sort()
        expect(
          visibleCharacters(items[pageIndex]!.map(item => item.str).join('')),
          `${label} page ${pageIndex + 1} items`,
        ).toEqual(visibleCharacters(tokens.join('')))
        for (const item of items[pageIndex]!) {
          const finite = [item.x, item.y, item.width, item.height, item.fontSize]
            .every(value => Number.isFinite(value))
          expect(finite, `${label} item geometry ${JSON.stringify(item.str)}`).toBe(true)
        }
      }

      const meta = await getMeta(document.bytes.slice())
      expect(meta.info.Title, label).toBe(document.info.Title)
      expect(meta.info.Author, label).toBe(document.info.Author)

      const extractedLinks = await extractLinks(document.bytes.slice())
      expect(extractedLinks.totalPages, label).toBe(document.pageTokens.length)
      expect(extractedLinks.links, label).toEqual(document.links)
    }
  })

  it('parses fuzzed PDF date strings per the specification', async () => {
    const { PDFDateString } = await getResolvedPDFJS()
    const random = mulberry32(99)

    for (let sample = 1; sample <= 150; sample++) {
      const year = 1990 + Math.floor(random() * 40)
      const month = 1 + Math.floor(random() * 12)
      const day = 1 + Math.floor(random() * 28)
      const hour = Math.floor(random() * 24)
      const minute = Math.floor(random() * 60)
      const second = Math.floor(random() * 60)
      const pad = (value: number) => String(value).padStart(2, '0')

      const offsetRoll = random()
      const offsetHours = Math.floor(random() * 12)
      const offsetMinutes = Math.floor(random() * 60)
      const timezone = offsetRoll < 0.25
        ? 'Z'
        : offsetRoll < 0.5
          ? ''
          : `${offsetRoll < 0.75 ? '+' : '-'}${pad(offsetHours)}'${pad(offsetMinutes)}'`
      const offsetTotalMinutes = timezone.startsWith('+')
        ? offsetHours * 60 + offsetMinutes
        : timezone.startsWith('-')
          ? -(offsetHours * 60 + offsetMinutes)
          : 0

      const dateString = `D:${year}${pad(month)}${pad(day)}${pad(hour)}${pad(minute)}${pad(second)}${timezone}`
      const parsed = PDFDateString.toDateObject(dateString)
      const expected = Date.UTC(year, month - 1, day, hour, minute, second)
        - offsetTotalMinutes * 60 * 1000
      expect(parsed?.getTime(), dateString).toBe(expected)
    }

    // Reduced-precision dates fall back to the spec defaults.
    expect(PDFDateString.toDateObject('D:2024')?.getTime()).toBe(Date.UTC(2024, 0, 1))
    expect(PDFDateString.toDateObject('D:202403')?.getTime()).toBe(Date.UTC(2024, 2, 1))

    for (let sample = 1; sample <= 60; sample++) {
      const garbage = Array.from(
        { length: Math.floor(random() * 20) },
        () => String.fromCharCode(32 + Math.floor(random() * 90)),
      ).join('')
      for (const candidate of [garbage, `D:${garbage}`]) {
        const parsed = PDFDateString.toDateObject(candidate)
        const wellFormed = parsed === null
          || (parsed instanceof Date && !Number.isNaN(parsed.getTime()))
        expect(wellFormed, `input ${JSON.stringify(candidate)}`).toBe(true)
      }
    }
  })

  it('parses authored dates end to end through getMeta', async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = mulberry32(600 + seed)
      const year = 2000 + Math.floor(random() * 30)
      const month = 1 + Math.floor(random() * 12)
      const day = 1 + Math.floor(random() * 28)
      const pad = (value: number) => String(value).padStart(2, '0')
      const creation = `D:${year}${pad(month)}${pad(day)}120000+02'00'`

      const document = authorPdf({
        pages: [{ runs: [{ text: 'dated', x: 57, y: 780, size: 12 }] }],
        info: { CreationDate: creation },
      })

      const { info } = await getMeta(document, { parseDates: true })
      expect(info.CreationDate, creation).toBeInstanceOf(Date)
      expect(info.CreationDate.getTime(), creation)
        .toBe(Date.UTC(year, month - 1, day, 12) - 2 * 60 * 60 * 1000)
    }
  })

  it('survives truncated documents without hanging', async () => {
    const random = mulberry32(7000)
    const document = fuzzedDocument(random)

    for (let sample = 1; sample <= 20; sample++) {
      const fraction = 0.1 + random() * 0.85
      const truncated = document.bytes.slice(0, Math.floor(document.bytes.length * fraction))
      const outcome = await extractText(truncated).then(
        () => 'resolved',
        () => 'rejected',
      )
      expect(['resolved', 'rejected'], `fraction ${fraction.toFixed(2)}`).toContain(outcome)
    }
  }, 30000)
})
