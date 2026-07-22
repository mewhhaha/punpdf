// @ts-check
/* eslint-disable antfu/no-import-dist -- verifies generated package entry points */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { glob } from 'tinyglobby'
import { extractHTML as extractHTMLWithJavaScript } from '../dist/index.mjs'
import { extractHTML as extractHTMLWithWasm, initializeWasm } from '../dist/wasm.mjs'

const fixturePaths = await glob('test/fixtures/*.pdf')
const fixtures = await Promise.all(fixturePaths.map(async fixturePath => ({
  bytes: await readFile(fixturePath),
  fixturePath,
})))
const warmupFixture = fixtures[0]
if (!warmupFixture) {
  throw new Error('WASM verification requires at least one PDF fixture')
}

await extractHTMLWithJavaScript(new Uint8Array(warmupFixture.bytes))
const javascriptResults = new Map()
const javascriptStart = performance.now()
for (const { bytes, fixturePath } of fixtures) {
  javascriptResults.set(
    fixturePath,
    await extractHTMLWithJavaScript(new Uint8Array(bytes)),
  )
}
const javascriptDuration = performance.now() - javascriptStart

await initializeWasm()
await extractHTMLWithWasm(new Uint8Array(warmupFixture.bytes))
const wasmStart = performance.now()
for (const { bytes, fixturePath } of fixtures) {
  const wasmResult = await extractHTMLWithWasm(new Uint8Array(bytes))
  if (JSON.stringify(wasmResult) !== JSON.stringify(javascriptResults.get(fixturePath))) {
    throw new Error(`WASM HTML output differs for ${fixturePath}`)
  }
}
const wasmDuration = performance.now() - wasmStart

console.log(JSON.stringify({
  fixtures: fixturePaths.length,
  javascriptMilliseconds: Math.round(javascriptDuration * 100) / 100,
  wasmMilliseconds: Math.round(wasmDuration * 100) / 100,
}))
