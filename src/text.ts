import type { DocumentInitParameters, PDFDocumentProxy, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api'
import { getDocumentProxy, isPDFDocumentProxy } from './utils'
import { textInVisualOrder } from './visual-order'

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
    text: mergePages ? mergePageTexts(texts, readingOrder) : texts,
  }
}

function mergePageTexts(
  texts: string[],
  readingOrder: NonNullable<ExtractTextOptions['readingOrder']>,
) {
  // Visual order infers the line structure; collapsing whitespace would
  // destroy it again.
  if (readingOrder === 'visual') {
    return texts.join('\n\n')
  }

  return texts.join('\n').replace(/\s+/g, ' ')
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

  return textInVisualOrder(items, page.getViewport({ scale: 1 }).transform)
}
