import type { DocumentInitParameters, PDFDocumentProxy, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api'
import { getDocumentProxy, isPDFDocumentProxy } from './utils'

export interface StructuredTextItem {
  /** Text content. */
  str: string
  /** X position in PDF coordinate space (origin: bottom-left). */
  x: number
  /** Y position in PDF coordinate space (origin: bottom-left). */
  y: number
  /** Width in device space. */
  width: number
  /** Height in device space. */
  height: number
  /** Font size derived from the transformation matrix. */
  fontSize: number
  /** Font family name. */
  fontFamily: string
  /** Text direction: `"ltr"`, `"rtl"`, or `"ttb"`. */
  dir: string
  /** Whether the text item is followed by a line break. */
  hasEOL: boolean
}

export interface ExtractTextOptions {
  mergePages?: boolean
  readingOrder?: 'content' | 'visual'
}

export async function extractTextItems(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
): Promise<{ totalPages: number, items: StructuredTextItem[][] }> {
  const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data)
  const items = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, i) => getPageTextItems(pdf, i + 1)),
  )

  return { totalPages: pdf.numPages, items }
}

async function getPageTextItems(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<StructuredTextItem[]> {
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  const styles = content.styles as Record<string, TextStyle>

  return (content.items as TextItem[])
    .filter(item => item.str != null)
    .map((item) => {
      const [_a, _b, c, d, e, f] = item.transform
      return {
        str: item.str,
        x: e,
        y: f,
        width: item.width,
        height: item.height,
        fontSize: Math.hypot(c, d),
        fontFamily: styles[item.fontName]?.fontFamily ?? '',
        dir: item.dir,
        hasEOL: item.hasEOL,
      }
    })
}

export function extractText(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: ExtractTextOptions & { mergePages?: false },
): Promise<{
  totalPages: number
  text: string[]
}>
export function extractText(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: ExtractTextOptions & { mergePages: true },
): Promise<{
  totalPages: number
  text: string
}>
export async function extractText(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: ExtractTextOptions = {},
) {
  const { mergePages = false, readingOrder = 'content' } = options
  const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data)
  const texts = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, i) => getPageText(pdf, i + 1, readingOrder)),
  )

  return {
    totalPages: pdf.numPages,
    text: mergePages ? texts.join('\n').replace(/\s+/g, ' ') : texts,
  }
}

async function getPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  readingOrder: NonNullable<ExtractTextOptions['readingOrder']>,
) {
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  const items = (content.items as TextItem[]).filter(item => item.str != null)

  if (readingOrder === 'content') {
    return items
      .map(item => item.str + (item.hasEOL ? '\n' : ''))
      .join('')
  }

  const [viewportA, viewportB, viewportC, viewportD, viewportX, viewportY]
    = page.getViewport({ scale: 1 }).transform as [number, number, number, number, number, number]
  const positionedItems = items
    .filter(item => item.str.length > 0)
    .map((item) => {
      const [_a, _b, c, d, itemX, itemY] = item.transform
      const transformedC = viewportA * c + viewportC * d
      const transformedD = viewportB * c + viewportD * d
      const x = viewportA * itemX + viewportC * itemY + viewportX
      const y = viewportB * itemX + viewportD * itemY + viewportY
      return { item, fontSize: Math.hypot(transformedC, transformedD), x, y }
    })
    .sort((left, right) => left.y - right.y || left.x - right.x)

  // Embedded font metrics can overstate run widths, so repeated x positions
  // are stronger evidence of a table boundary than the measured text gap.
  const columnBaselines = new Map<number, Set<number>>()
  for (const positionedItem of positionedItems) {
    if (!/^\s*$/.test(positionedItem.item.str)) {
      const columnBucket = Math.round(positionedItem.x * 2)
      const baselines = columnBaselines.get(columnBucket) ?? new Set<number>()
      baselines.add(Math.round(positionedItem.y * 2))
      columnBaselines.set(columnBucket, baselines)
    }
  }

  const lines: Array<{
    baseline: number
    fontSize: number
    items: typeof positionedItems
  }> = []

  for (const positionedItem of positionedItems) {
    const line = lines.at(-1)
    const baselineTolerance = line
      ? Math.max(0.5, Math.min(line.fontSize, positionedItem.fontSize) * 0.25)
      : 0

    if (!line || Math.abs(line.baseline - positionedItem.y) > baselineTolerance) {
      lines.push({
        baseline: positionedItem.y,
        fontSize: positionedItem.fontSize,
        items: [positionedItem],
      })
      continue
    }

    line.items.push(positionedItem)
    line.fontSize = Math.max(line.fontSize, positionedItem.fontSize)
  }

  return lines
    .map((line) => {
      line.items.sort((left, right) => left.x - right.x)

      let rightEdge: number | undefined
      let text = ''
      for (const positionedItem of line.items) {
        const itemText = positionedItem.item.str
        if (/^\s+$/.test(itemText)) {
          if (text && !text.endsWith(' '))
            text += ' '
          continue
        }

        const gap = rightEdge === undefined ? 0 : positionedItem.x - rightEdge
        const columnBucket = Math.round(positionedItem.x * 2)
        const columnTolerance = Math.ceil(positionedItem.fontSize)
        const alignedBaselines = new Set<number>()
        for (let nearbyBucket = columnBucket - columnTolerance; nearbyBucket <= columnBucket + columnTolerance; nearbyBucket++) {
          for (const baseline of columnBaselines.get(nearbyBucket) ?? [])
            alignedBaselines.add(baseline)
        }

        const followsWordGap = gap > positionedItem.fontSize * 0.1
        const startsAlignedColumn = alignedBaselines.size >= 3
        if (text && !text.endsWith(' ') && (followsWordGap || startsAlignedColumn))
          text += ' '

        text += itemText
        rightEdge = positionedItem.x + positionedItem.item.width
      }

      return text.trimEnd()
    })
    .join('\n')
}
