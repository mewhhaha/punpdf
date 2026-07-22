// @ts-check
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const generatedPaths = [
  'dist/index.cjs',
  'dist/index.d.cts',
  'dist/index.d.mts',
  'dist/index.d.ts',
  'dist/index.mjs',
  'dist/shared',
  'dist/wasm.cjs',
  'dist/wasm.d.cts',
  'dist/wasm.d.mts',
  'dist/wasm.d.ts',
  'dist/wasm.mjs',
  'dist/wasm-module.d.mts',
  'dist/wasm-module.d.ts',
  'dist/wasm-module.mjs',
  'dist/punpdf_wasm.wasm',
]

await Promise.all(generatedPaths.map(generatedPath =>
  fsp.rm(path.resolve(rootDir, generatedPath), { force: true, recursive: true })))

const wasmPath = path.resolve(
  rootDir,
  'wasm/target/wasm32-unknown-unknown/release/punpdf_wasm.wasm',
)
await fsp.mkdir(path.resolve(rootDir, 'dist'), { recursive: true })
await fsp.copyFile(wasmPath, path.resolve(rootDir, 'dist/punpdf_wasm.wasm'))
await fsp.writeFile(
  path.resolve(rootDir, 'dist/wasm-module.mjs'),
  '/* @ts-self-types="./wasm-module.d.ts" */\nimport wasmModule from \'./punpdf_wasm.wasm\'\n\nexport default wasmModule\n',
  'utf8',
)
await fsp.writeFile(
  path.resolve(rootDir, 'dist/wasm-module.d.mts'),
  'declare const wasmModule: WebAssembly.Module\n\nexport default wasmModule\n',
  'utf8',
)
await fsp.copyFile(
  path.resolve(rootDir, 'dist/wasm-module.d.mts'),
  path.resolve(rootDir, 'dist/wasm-module.d.ts'),
)
