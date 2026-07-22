# punpdf

> [!IMPORTANT]
> **punpdf is built from [unpdf](https://github.com/unjs/unpdf) by UnJS.** This fork retains unpdf's MIT-licensed foundation and full Git history while focusing on text extraction accuracy, including visual reading order, rotated pages, multi-column layouts, and table-aware spacing.

Utilities for PDF extraction and rendering across JavaScript runtimes including Node.js, Deno, Bun, browsers, and serverless environments like Cloudflare Workers. Especially useful for AI applications that need to summarize or analyze PDF documents.

Ships with a serverless build of Mozilla's [PDF.js](https://github.com/mozilla/pdf.js), optimized for edge environments. If you're coming from [`pdf-parse`](https://www.npmjs.com/package/pdf-parse), `punpdf` provides a modern alternative with broader runtime support.

## Features

- 🏗️ Works in Node.js, Deno, Bun, browsers, and serverless environments
- 🪭 Includes a serverless build of PDF.js ([`@mewhhaha/punpdf/pdfjs`](./package.json))
- 💬 Extract [text](#extract-text-from-pdf), [links](#extractlinks), and [images](#extractimages) from PDF files
- 📄 Convert visually detected document structure to semantic [HTML](#extracthtml)
- 🧠 Designed for AI applications and PDF summarization
- 🧱 Supports custom PDF.js modules, including the official and legacy builds

## Installation

```bash
# JSR with Deno
deno add jsr:@mewhhaha/punpdf

# JSR with pnpm
pnpm add jsr:@mewhhaha/punpdf
```

Import the package as `@mewhhaha/punpdf` with either installation method.

## Usage

### Extract Text From PDF

```ts
import { extractText, getDocumentProxy } from '@mewhhaha/punpdf'

// Fetch a PDF from the web or load it from the file system
const buffer = await fetch('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf')
  .then(res => res.arrayBuffer())

const pdf = await getDocumentProxy(new Uint8Array(buffer))
const { totalPages, text } = await extractText(pdf, { mergePages: true })

console.log(`Total pages: ${totalPages}`)
console.log(text)
```

### Official or Legacy PDF.js Build

Usually you don't need to worry about the PDF.js build. `punpdf` ships with a serverless build of PDF.js 5.6.205. However, if you want to use the official PDF.js version or the legacy build, you can define a custom PDF.js module.

Install `pdfjs-dist` in your application before using one of its builds.

> [!WARNING]
> PDF.js v5.x uses `Promise.withResolvers`, which may not be supported in all environments, such as Node < 22. Consider using the bundled serverless build, which includes a polyfill, or use an older version of PDF.js.

For example, if you want to use the official PDF.js build:

```ts
import { definePDFJSModule, extractText, getDocumentProxy } from '@mewhhaha/punpdf'

// Define the PDF.js build before using any other punpdf method
await definePDFJSModule(() => import('pdfjs-dist'))

// Now, you can use all punpdf methods with the official PDF.js build
const pdf = await getDocumentProxy(/* … */)
const { text } = await extractText(pdf)
```

### PDF.js API

`punpdf` provides helpful [methods](#api) to work with PDF files, such as `extractText` and `extractImages`, which should cover most use cases. However, if you need more control over the PDF.js API, you can use the `getResolvedPDFJS` method to get the resolved PDF.js module.

Access the PDF.js API directly by calling `getResolvedPDFJS`:

```ts
import { getResolvedPDFJS } from '@mewhhaha/punpdf'

const { version } = await getResolvedPDFJS()
```

> [!NOTE]
> If no other PDF.js build was defined, the serverless build will always be used.

For example, you can use the `getDocument` method to load a PDF file and then use the `getMetadata` method to get the metadata of the PDF file:

```ts
import { readFile } from 'node:fs/promises'
import { getResolvedPDFJS } from '@mewhhaha/punpdf'

const { getDocument } = await getResolvedPDFJS()
const data = await readFile('./dummy.pdf')
const document = await getDocument(new Uint8Array(data)).promise

console.log(await document.getMetadata())
```

## How It Works

> [!NOTE]
> The serverless PDF.js bundle is built from PDF.js v5.6.205.

Heart and soul of this package is the [`pdfjs.rollup.config.ts`](./pdfjs.rollup.config.ts) file. It uses [Rollup](https://rollupjs.org/) to bundle PDF.js into a single file for serverless environments. The key techniques:

- **String replacements** strip browser-specific references from the PDF.js source.
- **Worker inlining** embeds the PDF.js worker directly into the main bundle, since serverless runtimes can't load separate worker files.
- **Global polyfills** provide missing APIs like `Promise.withResolvers` and `FinalizationRegistry` (unavailable in Node.js < 22 and Cloudflare Workers, respectively).

## API

### `definePDFJSModule`

Allows to define a custom PDF.js build. This method should be called before using any other method. If no custom build is defined, the serverless build will be used.

**Type Declaration**

```ts
function definePDFJSModule(pdfjs: () => Promise<PDFJS>): Promise<void>
```

### `getResolvedPDFJS`

Returns the resolved PDF.js module. If no other PDF.js build was defined, the serverless build will be used. This method is useful if you want to use the PDF.js API directly.

**Type Declaration**

```ts
function getResolvedPDFJS(): Promise<PDFJS>
```

### `getDocumentProxy`

Creates a `PDFDocumentProxy` from binary PDF data. Every extraction method accepts either raw data or an existing proxy – use this when you want to reuse one document across multiple calls.

Applies sensible defaults: `isEvalSupported: false` and `useSystemFonts: true`; in Node.js additionally `disableFontFace: true` and, when `pdfjs-dist` is installed locally, `standardFontDataUrl` resolved from that package (see the font rendering tip in [`renderPageAsImage`](#renderpageasimage)).

**Type Declaration**

```ts
function getDocumentProxy(
  data: DocumentInitParameters['data'],
  options?: DocumentInitParameters,
): Promise<PDFDocumentProxy>
```

### `getMeta`

Extracts metadata from a PDF. If `parseDates` is set to `true`, the date properties will be parsed into `Date` objects.

**Type Declaration**

```ts
function getMeta(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: {
    parseDates?: boolean
  },
): Promise<{
  info: Record<string, any>
  metadata: Record<string, any>
}>
```

### `extractText`

Extracts all text from a PDF. If `mergePages` is set to `true`, the text of all pages will be merged into a single string. Otherwise, an array of strings for each page will be returned.

By default, text follows the PDF content stream. Set `readingOrder` to `"visual"` to order text from top to bottom and left to right based on its rendered page position. Visual order also infers spaces between separate text runs, which is useful for PDFs whose content stream does not follow their displayed reading order. Runs separated by more than two font sizes of whitespace (e.g. table cells) are separated by a tab instead of a space, and side-by-side prose columns are read column by column. With `mergePages`, visual order joins pages with a blank line instead of collapsing whitespace, so the inferred line structure survives.

Text rotated within a page (sideways tables, rotated chart labels) is grouped by orientation and read in its own frame, ordered by where each orientation starts on the page. Within a line, contiguous right-to-left runs are reordered so the text reads logically; complex bidirectional nesting and vertical (top-to-bottom) writing are not interpreted. Visual order can also only order text that PDF.js extracts: words the document renders without any space between them stay joined.

**Type Declaration**

```ts
function extractText(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: {
    mergePages?: false
    readingOrder?: 'content' | 'visual'
  }
): Promise<{
  totalPages: number
  text: string[]
}>
function extractText(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: {
    mergePages: true
    readingOrder?: 'content' | 'visual'
  }
): Promise<{
  totalPages: number
  text: string
}>
```

### `extractTextPages`

Streams text sequentially, one page at a time. Use this API for large documents or memory-constrained runtimes such as Cloudflare Workers. When passed raw PDF bytes, the iterator releases page resources after completion or early cancellation.

```ts
import { extractTextPages } from '@mewhhaha/punpdf'

for await (const page of extractTextPages(buffer, { readingOrder: 'visual' })) {
  console.log(`Page ${page.pageNumber} of ${page.totalPages}`)
  console.log(page.text)
}
```

**Type Declaration**

```ts
function extractTextPages(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: {
    readingOrder?: 'content' | 'visual'
  },
): AsyncGenerator<{
  pageNumber: number
  totalPages: number
  text: string
}>
```

### `extractTextItems`

Extracts text with layout information – one array of positioned items per page. Useful when plain text is not enough and you need coordinates, font sizes, or reading direction, e.g. for table detection or positional parsing.

**Type Declaration**

```ts
interface StructuredTextItem {
  str: string
  /** X position in PDF coordinate space (origin: bottom-left). */
  x: number
  /** Y position in PDF coordinate space (origin: bottom-left). */
  y: number
  width: number
  height: number
  fontSize: number
  fontFamily: string
  /** Text direction: `"ltr"`, `"rtl"`, or `"ttb"`. */
  dir: string
  /** Whether the text item is followed by a line break. */
  hasEOL: boolean
}

function extractTextItems(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
): Promise<{
  totalPages: number
  items: StructuredTextItem[][]
}>
```

### `extractHTML`

Extracts each page in visual reading order as a complete HTML document. Report headings, paragraphs, nested outlines, lists, metadata, and tables use semantic elements. Dense tables use complete visual rows to keep narrowly spaced values in separate cells, adjacent sidebar text stays outside the detected grid, and wrapped cells use `<br>` without becoming extra columns. Stacked and grouped headers use `<thead>`, `scope`, `rowspan`, and `colspan`; full-width table sections and subtotal rows retain their structure and emphasis. Continuation pages inherit compatible table headers only when the next page provides continuation evidence. Financial grids, exhibit indexes, and signature blocks whose positioned text cannot support reliable semantic associations use spatial `<pre>` markup instead.

PDFs generally store positioned text rather than document semantics, so structure is inferred from reusable layout evidence such as alignment, spacing, repetition, and visual prominence. The result is intended for browser viewing and HTML-aware language models.

When `mergePages` is `true`, all page `<article>` elements are returned in one HTML document with horizontal-rule page boundaries. Otherwise, `html` contains one complete HTML document per PDF page.

```ts
import { extractHTML } from '@mewhhaha/punpdf'

const { html } = await extractHTML(buffer, { mergePages: true })
console.log(html)
```

#### Rust/WebAssembly accelerator

For table-heavy financial reports, the optional WebAssembly entry keeps the same `extractHTML` API and output while running positional table-cell matching in compiled Rust. PDF.js parsing and semantic HTML reconstruction remain in JavaScript.

```ts
import { extractHTML } from '@mewhhaha/punpdf/wasm'

const { html } = await extractHTML(buffer, { mergePages: true })
```

The default entry embeds and lazily instantiates the Wasm binary. Cloudflare Workers prohibits instantiating Wasm from a byte buffer, so pass the separately published, precompiled module during module initialization instead:

```ts
import { extractHTML, initializeWasm } from '@mewhhaha/punpdf/wasm'
import wasmModule from '@mewhhaha/punpdf/wasm-module'

await initializeWasm(wasmModule)

export default {
  async fetch(request: Request) {
    const pdf = new Uint8Array(await request.arrayBuffer())
    const { html } = await extractHTML(pdf, { mergePages: true })
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  },
}
```

Set `preserveLayout` to include a rendered image of every source page before its semantic content. This retains charts, logos, signatures, and other non-text visuals at the cost of larger HTML. Node.js callers must provide the optional `@napi-rs/canvas` import.

```ts
const { html } = await extractHTML(buffer, {
  mergePages: true,
  preserveLayout: {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 1,
  },
})
```

**Type Declaration**

```ts
function extractHTML(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: {
    mergePages?: false
    preserveLayout?: {
      canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>
      scale?: number
    }
  },
): Promise<{
  totalPages: number
  html: string[]
}>
function extractHTML(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: {
    mergePages: true
    preserveLayout?: {
      canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>
      scale?: number
    }
  },
): Promise<{
  totalPages: number
  html: string
}>
```

### `extractLinks`

Extracts the external URLs from link annotations in a PDF document. It does not detect URL-shaped text or return internal document links.

**Type Declaration**

```ts
function extractLinks(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
): Promise<{
  totalPages: number
  links: string[]
}>
```

**Example**

```ts
import { readFile } from 'node:fs/promises'
import { extractLinks, getDocumentProxy } from '@mewhhaha/punpdf'

// Load a PDF file
const buffer = await readFile('./document.pdf')
const pdf = await getDocumentProxy(new Uint8Array(buffer))

// Extract external link annotation URLs from the PDF
const { totalPages, links } = await extractLinks(pdf)

console.log(`Total pages: ${totalPages}`)
console.log(`Found ${links.length} links:`)
for (const link of links) console.log(link)
```

### `extractImages`

Extracts image XObjects painted on a specific PDF page, including their width, height, and calculated color channel count. Inline images and image masks are not returned. Works with both the serverless and official PDF.js builds.

**Type Declaration**

```ts
interface ExtractedImageObject {
  data: Uint8ClampedArray
  width: number
  height: number
  channels: 1 | 3 | 4
  key: string
}

function extractImages(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  pageNumber: number,
): Promise<ExtractedImageObject[]>
```

**Example**

> [!NOTE]
> The following example uses the [sharp](https://github.com/lovell/sharp) library to process and save the extracted images. You will need to install it with your preferred package manager.

```ts
import { readFile } from 'node:fs/promises'
import { extractImages, getDocumentProxy } from '@mewhhaha/punpdf'
import sharp from 'sharp'

async function extractPdfImages() {
  const buffer = await readFile('./document.pdf')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))

  // Extract images from page 1
  const imagesData = await extractImages(pdf, 1)
  console.log(`Found ${imagesData.length} images on page 1`)

  // Process each image with sharp (optional)
  let totalImagesProcessed = 0
  for (const imgData of imagesData) {
    const imageIndex = ++totalImagesProcessed

    await sharp(imgData.data, {
      raw: {
        width: imgData.width,
        height: imgData.height,
        channels: imgData.channels
      }
    })
      .png()
      .toFile(`image-${imageIndex}.png`)

    console.log(`Saved image ${imageIndex} (${imgData.width}x${imgData.height}, ${imgData.channels} channels)`)
  }
}

extractPdfImages().catch(console.error)
```

### `renderPageAsImage`

To render a PDF page as an image, you can use the `renderPageAsImage` method. This method will return an `ArrayBuffer` of the rendered image. It can also return a data URL (`string`) if `toDataURL` option is set to `true`.

> [!NOTE]
> This method will only work in Node.js and browser environments.

In order to use this method, make sure to meet the following requirements:

- Use the official PDF.js build (see [Official or Legacy PDF.js Build](#official-or-legacy-pdfjs-build)).
- Install the [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) package if you are using Node.js. This package is required to render the PDF page as an image.

> [!TIP]
> In Node.js, `getDocumentProxy` automatically sets `disableFontFace: true`. When `pdfjs-dist` is installed locally, it also resolves `standardFontDataUrl` from that package for correct font rendering. To customize this behavior, pass your own options:
>
> ```ts
> const pdf = await getDocumentProxy(buffer, {
>   disableFontFace: false,
>   standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@latest/standard_fonts/',
> })
> ```

**Type Declaration**

```ts
function renderPageAsImage(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  pageNumber: number,
  options?: {
    canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>
    /** @default 1.0 */
    scale?: number
    width?: number
    height?: number
    toDataURL?: false
  },
): Promise<ArrayBuffer>
function renderPageAsImage(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  pageNumber: number,
  options: {
    canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>
    /** @default 1.0 */
    scale?: number
    width?: number
    height?: number
    toDataURL: true
  },
): Promise<string>
```

**Examples**

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { definePDFJSModule, renderPageAsImage } from '@mewhhaha/punpdf'

// Use the official PDF.js build
await definePDFJSModule(() => import('pdfjs-dist'))

const pdf = await readFile('./dummy.pdf')
const buffer = new Uint8Array(pdf)
const pageNumber = 1

const result = await renderPageAsImage(buffer, pageNumber, {
  canvasImport: () => import('@napi-rs/canvas'),
  scale: 2,
})
await writeFile('dummy-page-1.png', new Uint8Array(result))
```

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { definePDFJSModule, renderPageAsImage } from '@mewhhaha/punpdf'

await definePDFJSModule(() => import('pdfjs-dist'))

const pdf = await readFile('./dummy.pdf')
const buffer = new Uint8Array(pdf)
const pageNumber = 1

const result = await renderPageAsImage(buffer, pageNumber, {
  canvasImport: () => import('@napi-rs/canvas'),
  scale: 2,
  toDataURL: true,
})

const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dummy Page</title>
  </head>
  <body>
    <img alt="Example Page" src="${result}">
  </body>
</html>`

await writeFile('dummy-page-1.html', html)
```

## Building from source

The standard build also compiles the Rust crate, so the `wasm32-unknown-unknown` target must be installed:

```bash
rustup target add wasm32-unknown-unknown
pnpm build
```

## License

[MIT](./LICENSE) License © 2023-PRESENT [Johann Schopplich](https://github.com/johannschopplich)
