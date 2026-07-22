import type { StructuredTextItem } from './text'

export interface LocatedTableCell {
  cellIndex: number
  rowIndex: number
  value: string
  x: number
  y: number
}

export type WasmTableLocator = (
  rows: string[][],
  positionedText: StructuredTextItem[],
) => LocatedTableCell[]

let wasmTableLocator: WasmTableLocator | undefined

export function defineWasmTableLocator(locator: WasmTableLocator): void {
  wasmTableLocator = locator
}

export function getWasmTableLocator(): WasmTableLocator | undefined {
  return wasmTableLocator
}
