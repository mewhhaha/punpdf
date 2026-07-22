// @ts-check
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'tinyglobby'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const wasmPath = path.resolve(
  rootDir,
  'wasm/target/wasm32-unknown-unknown/release/punpdf_wasm.wasm',
)
const wasmBinaryBase64 = (await fsp.readFile(wasmPath)).toString('base64')
const targets = await glob(['dist/**/*.{d.cts,d.mts,d.ts}'], {
  cwd: rootDir,
  ignore: ['**/types/**'],
})

for (const filename of targets) {
  await relativeTypePaths(filename)
}

const modules = await glob(['dist/**/*.{cjs,mjs}'], { cwd: rootDir })
let pdfJSImportCount = 0
let wasmPlaceholderCount = 0
for (const filename of modules) {
  const modulePath = path.resolve(rootDir, filename)
  const content = await fsp.readFile(modulePath, 'utf8')
  const relativePDFJSImport = path.relative(
    path.dirname(modulePath),
    path.resolve(rootDir, 'dist/pdfjs.mjs'),
  ).replaceAll(path.sep, '/')
  let builtContent = content.replace(
    /(['"])@mewhhaha\/punpdf\/pdfjs\1/g,
    `$1${relativePDFJSImport.startsWith('.') ? '' : './'}${relativePDFJSImport}$1`,
  )
  if (builtContent !== content) {
    pdfJSImportCount++
  }
  if (builtContent.includes('__PUNPDF_WASM_BASE64__')) {
    builtContent = builtContent.replaceAll('__PUNPDF_WASM_BASE64__', wasmBinaryBase64)
    wasmPlaceholderCount++
  }

  const jsrTypeDirective = filename === 'dist/index.mjs'
    ? '/* @ts-self-types="./index.d.ts" */\n'
    : filename === 'dist/wasm.mjs'
      ? '/* @ts-self-types="./wasm.d.ts" */\n'
      : ''

  await fsp.writeFile(modulePath, `${jsrTypeDirective}${builtContent}`, 'utf8')
}
if (pdfJSImportCount === 0) {
  throw new Error('built modules do not import the serverless PDF.js bundle')
}
if (wasmPlaceholderCount === 0) {
  throw new Error('built modules do not contain the WASM binary placeholder')
}

/**
 * @param {string} filename
 */
async function relativeTypePaths(filename) {
  let content = await fsp.readFile(filename, 'utf8')
  if (!content.includes('pdfjs-dist/types'))
    return

  const relativePath = path.relative(
    path.resolve(filename, '..'),
    path.resolve(rootDir, 'dist/types'),
  )

  // Replace `pdfjs-dist/types` import path with relative path
  content = content.replace(
    /pdfjs-dist\/types/g,
    relativePath.startsWith('.') ? relativePath : `./${relativePath}`,
  )

  await fsp.writeFile(path.resolve(rootDir, filename), content, 'utf8')
}
