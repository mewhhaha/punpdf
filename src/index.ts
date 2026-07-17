import { extractImages as _extractImages, renderPageAsImage as _renderPageAsImage } from './image'
import { extractLinks as _extractLinks } from './links'
import { getMeta as _getMeta } from './meta'
import { extractText as _extractText, extractTextItems as _extractTextItems } from './text'
import { resolvePDFJSImport } from './utils'

export { configure, definePDFJSModule } from './config'
export { createIsomorphicCanvasFactory } from './image'
export type { ExtractTextOptions, StructuredTextItem } from './text'

export {
  getDocumentProxy,
  getResolvedPDFJS,
  resolvePDFJSImport,
} from './utils'

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
