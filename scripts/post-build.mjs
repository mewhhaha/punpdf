// @ts-check
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'tinyglobby'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const targets = await glob(['dist/**/*.{d.cts,d.mts,d.ts}'], {
  cwd: rootDir,
  ignore: ['**/types/**'],
})

for (const filename of targets) {
  await relativeTypePaths(filename)
}

for (const filename of ['dist/index.cjs', 'dist/index.mjs']) {
  const modulePath = path.resolve(rootDir, filename)
  const content = await fsp.readFile(modulePath, 'utf8')
  const relativeImport = content.replace(
    /(['"])@mewhhaha\/punpdf\/pdfjs\1/g,
    '$1./pdfjs.mjs$1',
  )

  if (relativeImport === content) {
    throw new Error(`${filename} does not import the serverless PDF.js bundle`)
  }

  const jsrTypeDirective = filename.endsWith('.mjs')
    ? '/* @ts-self-types="./index.d.ts" */\n'
    : ''

  await fsp.writeFile(modulePath, `${jsrTypeDirective}${relativeImport}`, 'utf8')
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
