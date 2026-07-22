import type { DocumentInitParameters, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import type { ExtractHTMLOptions } from './html'
import type { StructuredTextItem } from './text'
import type { LocatedTableCell } from './wasm-bridge'
import { extractHTML as extractHTMLWithConfiguredPDFJS } from './html'
import { resolvePDFJSImport } from './utils'
import { defineWasmTableLocator } from './wasm-bridge'

const wasmBinaryBase64 = '__PUNPDF_WASM_BASE64__'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface PunpdfWasmExports extends WebAssembly.Exports {
  allocate: (length: number) => number
  deallocate_input: (pointer: number, length: number) => void
  deallocate_output: (pointer: number, length: number) => void
  locate_table_cells: (pointer: number, length: number) => bigint
  memory: WebAssembly.Memory
  set_positioned_text: (pointer: number, length: number) => bigint
}

class WasmRequestWriter {
  private bytes: Uint8Array
  private offset = 0
  private view: DataView

  constructor(byteLength: number) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError(`punpdf WASM request length ${byteLength} is invalid`)
    }
    this.bytes = new Uint8Array(byteLength)
    this.view = new DataView(this.bytes.buffer)
  }

  writeUint32(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF_FFFF) {
      throw new RangeError(`punpdf WASM ${field} ${value} is outside the uint32 range`)
    }
    this.view.setUint32(this.offset, value, true)
    this.offset += 4
  }

  writeFloat64(value: number): void {
    this.view.setFloat64(this.offset, value, true)
    this.offset += 8
  }

  writeString(value: Uint8Array, field: string): void {
    this.writeUint32(value.length, `${field} byte length`)
    this.bytes.set(value, this.offset)
    this.offset += value.length
  }

  finish(): Uint8Array {
    if (this.offset !== this.bytes.length) {
      throw new Error(
        `punpdf WASM request wrote ${this.offset} of ${this.bytes.length} allocated bytes`,
      )
    }
    return this.bytes
  }
}

let wasmInitialization: Promise<void> | undefined

export function initializeWasm(wasmModule?: WebAssembly.Module): Promise<void> {
  wasmInitialization ??= instantiateWasmTableLocator(wasmModule)
  return wasmInitialization
}

export function extractHTML(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options?: ExtractHTMLOptions & { mergePages?: false },
): Promise<{
  totalPages: number
  html: string[]
}>
export function extractHTML(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: ExtractHTMLOptions & { mergePages: true },
): Promise<{
  totalPages: number
  html: string
}>
export async function extractHTML(
  data: DocumentInitParameters['data'] | PDFDocumentProxy,
  options: ExtractHTMLOptions = {},
) {
  await Promise.all([resolvePDFJSImport(), initializeWasm()])
  return await (extractHTMLWithConfiguredPDFJS as any)(data, options)
}

async function instantiateWasmTableLocator(wasmModule?: WebAssembly.Module): Promise<void> {
  let instance: WebAssembly.Instance
  if (wasmModule) {
    instance = await WebAssembly.instantiate(wasmModule)
  }
  else {
    const binaryString = globalThis.atob(wasmBinaryBase64)
    const bytes = Uint8Array.from(binaryString, character => character.charCodeAt(0))
    const compiledWasm = await WebAssembly.compile(bytes as BufferSource)
    instance = await WebAssembly.instantiate(compiledWasm)
  }
  for (const exportName of [
    'allocate',
    'deallocate_input',
    'deallocate_output',
    'locate_table_cells',
    'set_positioned_text',
  ]) {
    if (typeof instance.exports[exportName] !== 'function') {
      throw new TypeError(`punpdf WASM module export "${exportName}" must be a function`)
    }
  }
  if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
    throw new TypeError('punpdf WASM module export "memory" must be WebAssembly.Memory')
  }
  const wasm = instance.exports as PunpdfWasmExports
  let configuredPositionedText: StructuredTextItem[] | undefined
  defineWasmTableLocator((rows, positionedText) => {
    if (configuredPositionedText !== positionedText) {
      configurePositionedText(wasm, positionedText)
      configuredPositionedText = positionedText
    }
    return locateTableCells(wasm, rows)
  })
}

function configurePositionedText(
  wasm: PunpdfWasmExports,
  positionedText: StructuredTextItem[],
): void {
  const encodedPositionedText = positionedText.map(textRun => ({
    bytes: textEncoder.encode(textRun.str),
    textRun,
  }))
  const requestLength = encodedPositionedText.reduce(
    (length, encodedTextRun) => length + 4 + encodedTextRun.bytes.length + 24,
    4,
  )
  const writer = new WasmRequestWriter(requestLength)
  writer.writeUint32(positionedText.length, 'positioned text count')
  for (const [index, { bytes, textRun }] of encodedPositionedText.entries()) {
    writer.writeString(bytes, `positioned text ${index}`)
    writer.writeFloat64(wasmCoordinate(textRun.x))
    writer.writeFloat64(wasmCoordinate(textRun.y))
    writer.writeFloat64(wasmCoordinate(textRun.fontSize))
  }
  const request = writer.finish()
  const response = callWasm(wasm, wasm.set_positioned_text, request)
  const payload = successfulWasmPayload('positioned text configuration', response)
  if (payload.length !== 0) {
    throw new TypeError(
      `punpdf WASM positioned text configuration returned ${payload.length} unexpected bytes`,
    )
  }
}

function locateTableCells(
  wasm: PunpdfWasmExports,
  rows: string[][],
): LocatedTableCell[] {
  const encodedRows = rows.map(row => row.map(value => ({
    bytes: textEncoder.encode(value),
    value,
  })))
  const requestLength = encodedRows.reduce(
    (rowsLength, row) => row.reduce(
      (rowLength, cell) => rowLength + 4 + cell.bytes.length,
      rowsLength + 4,
    ),
    4,
  )
  const writer = new WasmRequestWriter(requestLength)
  writer.writeUint32(rows.length, 'row count')
  for (const [rowIndex, row] of encodedRows.entries()) {
    writer.writeUint32(row.length, `row ${rowIndex} cell count`)
    for (const [cellIndex, cell] of row.entries()) {
      writer.writeString(cell.bytes, `row ${rowIndex} cell ${cellIndex}`)
    }
  }
  const request = writer.finish()
  const response = callWasm(wasm, wasm.locate_table_cells, request)
  const payload = successfulWasmPayload('table locator', response)
  if (payload.length < 4) {
    throw new TypeError(`punpdf WASM table locator returned only ${payload.length} payload bytes`)
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const cellCount = view.getUint32(0, true)
  const expectedLength = 4 + cellCount * 24
  if (payload.length !== expectedLength) {
    throw new TypeError(
      `punpdf WASM table locator returned ${payload.length} bytes for ${cellCount} cells; expected ${expectedLength}`,
    )
  }

  const locatedCells: LocatedTableCell[] = []
  let offset = 4
  for (let index = 0; index < cellCount; index++) {
    const cellIndex = view.getUint32(offset, true)
    const rowIndex = view.getUint32(offset + 4, true)
    const x = view.getFloat64(offset + 8, true)
    const y = view.getFloat64(offset + 16, true)
    const value = rows[rowIndex]?.[cellIndex]
    if (value === undefined) {
      throw new TypeError(
        `punpdf WASM table locator returned cell ${cellIndex} in row ${rowIndex} for a ${rows.length}-row request`,
      )
    }
    locatedCells.push({
      cellIndex,
      rowIndex,
      value: value.replace(/\\([\\|#])/g, '$1'),
      x,
      y,
    })
    offset += 24
  }
  return locatedCells
}

function callWasm(
  wasm: PunpdfWasmExports,
  operation: (pointer: number, length: number) => bigint,
  request: Uint8Array,
): Uint8Array {
  const inputPointer = wasm.allocate(request.length)
  new Uint8Array(wasm.memory.buffer, inputPointer, request.length).set(request)

  let packedOutput: bigint
  try {
    packedOutput = operation(inputPointer, request.length)
  }
  finally {
    wasm.deallocate_input(inputPointer, request.length)
  }

  const outputPointer = Number(packedOutput & 0xFFFF_FFFFn)
  const outputLength = Number(packedOutput >> 32n)
  const outputBytes = new Uint8Array(wasm.memory.buffer, outputPointer, outputLength).slice()
  wasm.deallocate_output(outputPointer, outputLength)
  return outputBytes
}

function successfulWasmPayload(operation: string, response: Uint8Array): Uint8Array {
  if (response.length === 0) {
    throw new TypeError(`punpdf WASM ${operation} returned an empty response`)
  }
  if (response[0] === 1) {
    throw new Error(`punpdf WASM ${operation} failed: ${textDecoder.decode(response.subarray(1))}`)
  }
  if (response[0] !== 0) {
    throw new TypeError(`punpdf WASM ${operation} returned unknown status ${response[0]}`)
  }
  return response.subarray(1)
}

function wasmCoordinate(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Number.NaN
  }
  return value
}
