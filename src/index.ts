import { extractImages as _extractImages, renderPageAsImage as _renderPageAsImage } from './image'
import { extractLinks as _extractLinks } from './links'
import { getMeta as _getMeta } from './meta'
import { extractMarkdown as _extractMarkdown, extractText as _extractText, extractTextBlocks as _extractTextBlocks, extractTextItems as _extractTextItems, extractTextPages as _extractTextPages } from './text'
import { resolvePDFJSImport } from './utils'

export { configure, definePDFJSModule } from './config'
export { createIsomorphicCanvasFactory } from './image'
export type { ExtractedTextPage, ExtractTextOptions, ExtractTextPagesOptions, StructuredTextItem } from './text'
export {
  getDocumentProxy,
  getResolvedPDFJS,
  resolvePDFJSImport,
} from './utils'

export type { TextBlock } from './visual-order'

export const getMeta: typeof _getMeta = async (...args) => {
  await resolvePDFJSImport()
  return await _getMeta(...args)
}

export const extractText: typeof _extractText = async (...args) => {
  await resolvePDFJSImport()
  return await (_extractText as any)(...args)
}

export const extractTextItems: typeof _extractTextItems = async (...args) => {
  await resolvePDFJSImport()
  return await _extractTextItems(...args)
}

export const extractTextPages: typeof _extractTextPages = async function* (...args) {
  await resolvePDFJSImport()
  yield* _extractTextPages(...args)
}

export const extractTextBlocks: typeof _extractTextBlocks = async (...args) => {
  await resolvePDFJSImport()
  return await _extractTextBlocks(...args)
}

export const extractMarkdown: typeof _extractMarkdown = async (...args) => {
  await resolvePDFJSImport()
  return await (_extractMarkdown as any)(...args)
}

export const extractImages: typeof _extractImages = async (...args) => {
  await resolvePDFJSImport()
  return await _extractImages(...args)
}

export const renderPageAsImage: typeof _renderPageAsImage = async (...args) => {
  await resolvePDFJSImport()
  return await (_renderPageAsImage as any)(...args)
}

export const extractLinks: typeof _extractLinks = async (...args) => {
  await resolvePDFJSImport()
  return await _extractLinks(...args)
}
