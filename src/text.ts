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
  /** Page-local key that distinguishes source font faces. */
  fontKey?: string
  /** Text direction: `"ltr"`, `"rtl"`, or `"ttb"`. */
  dir: string
  /** Whether the text item is followed by a line break. */
  hasEOL: boolean
}

export interface ExtractTextOptions {
  mergePages?: boolean
  readingOrder?: 'content' | 'visual'
}

export interface ExtractTextPagesOptions {
  readingOrder?: NonNullable<ExtractTextOptions['readingOrder']>
}

export interface ExtractedTextPage {
  pageNumber: number
  totalPages: number
  text: string
}

export async function extractVisualTextAndItems(
  document: PDFDocumentProxy,
): Promise<{ totalPages: number, text: string[], items: StructuredTextItem[][] }> {
  const text: string[] = []
  const items: StructuredTextItem[][] = []

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber)
    try {
      const content = await page.getTextContent()
      const textItems = (content.items as TextItem[]).filter(item => item.str != null)
      const styles = content.styles as Record<string, TextStyle>
      const fontKeys = new Map<string, string>()
      text.push(textInVisualOrder(textItems, page.getViewport({ scale: 1 }).transform))
      items.push(textItems.map((item) => {
        const [_a, _b, c, d, e, f] = item.transform
        if (!fontKeys.has(item.fontName)) {
          fontKeys.set(item.fontName, `font-${fontKeys.size + 1}`)
        }
        return {
          str: item.str,
          x: e,
          y: f,
          width: item.width,
          height: item.height,
          fontSize: Math.hypot(c, d),
          fontFamily: styles[item.fontName]?.fontFamily ?? '',
          fontKey: fontKeys.get(item.fontName),
          dir: item.dir,
          hasEOL: item.hasEOL,
        }
      }))
    }
    finally {
      page.cleanup()
    }
  }

  return { totalPages: document.numPages, text, items }
}

export async function extractTextItems(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
): Promise<{ totalPages: number, items: StructuredTextItem[][] }> {
  const ownsDocument = !isPDFDocumentProxy(data)
  const pdf = ownsDocument ? await getDocumentProxy(data) : data
  const items: StructuredTextItem[][] = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++)
      items.push(await getPageTextItems(pdf, pageNumber))
  }
  finally {
    if (ownsDocument)
      await pdf.cleanup()
  }

  return { totalPages: pdf.numPages, items }
}

async function getPageTextItems(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<StructuredTextItem[]> {
  const page = await document.getPage(pageNumber)

  try {
    const content = await page.getTextContent()
    const styles = content.styles as Record<string, TextStyle>
    const fontKeys = new Map<string, string>()

    return (content.items as TextItem[])
      .filter(item => item.str != null)
      .map((item) => {
        const [_a, _b, c, d, e, f] = item.transform
        if (!fontKeys.has(item.fontName)) {
          fontKeys.set(item.fontName, `font-${fontKeys.size + 1}`)
        }
        return {
          str: item.str,
          x: e,
          y: f,
          width: item.width,
          height: item.height,
          fontSize: Math.hypot(c, d),
          fontFamily: styles[item.fontName]?.fontFamily ?? '',
          fontKey: fontKeys.get(item.fontName),
          dir: item.dir,
          hasEOL: item.hasEOL,
        }
      })
  }
  finally {
    page.cleanup()
  }
}

export async function* extractTextPages(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: ExtractTextPagesOptions = {},
): AsyncGenerator<ExtractedTextPage> {
  const { readingOrder = 'content' } = options
  const ownsDocument = !isPDFDocumentProxy(data)
  const pdf = ownsDocument ? await getDocumentProxy(data) : data

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      yield {
        pageNumber,
        totalPages: pdf.numPages,
        text: await getPageText(pdf, pageNumber, readingOrder),
      }
    }
  }
  finally {
    if (ownsDocument)
      await pdf.cleanup()
  }
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
  const texts: string[] = []
  let totalPages = 0

  for await (const page of extractTextPages(data, { readingOrder })) {
    totalPages = page.totalPages
    texts.push(page.text)
  }

  return {
    totalPages,
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

  try {
    const content = await page.getTextContent()
    const items = (content.items as TextItem[]).filter(item => item.str != null)

    if (readingOrder === 'content') {
      return items
        .map(item => item.str + (item.hasEOL ? '\n' : ''))
        .join('')
    }

    return textInVisualOrder(items, page.getViewport({ scale: 1 }).transform)
  }
  finally {
    page.cleanup()
  }
}
