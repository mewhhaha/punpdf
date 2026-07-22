import type { TextItem } from 'pdfjs-dist/types/src/display/api'

/** The subset of a PDF.js text item that positions its text on the page. */
export type VisualOrderItem = Pick<TextItem, 'str' | 'transform' | 'width' | 'dir'>
  & { hasEOL?: boolean }

interface PositionedItem {
  item: VisualOrderItem
  fontSize: number
  x: number
  y: number
  width: number
}

interface Line {
  baseline: number
  fontSize: number
  top: number
  items: PositionedItem[]
}

/**
 * Assembles page text in visual reading order: top to bottom, left to right,
 * as positioned by the given viewport transform. Side-by-side text blocks
 * (e.g. two-column layouts) are read block by block; within a block, items
 * are grouped into lines by baseline and spaces are inferred between
 * separate text runs.
 */
export function textInVisualOrder(
  items: VisualOrderItem[],
  viewportTransform: number[],
): string {
  const [viewportA, viewportB, viewportC, viewportD, viewportX, viewportY]
    = viewportTransform as [number, number, number, number, number, number]
  const orientedItems = items
    .filter(item => item.str.length > 0)
    .map((item) => {
      const [a, b, c, d, itemX, itemY] = item.transform
      const advanceX = viewportA * a + viewportC * b
      const advanceY = viewportB * a + viewportD * b
      const transformedC = viewportA * c + viewportC * d
      const transformedD = viewportB * c + viewportD * d
      const x = viewportA * itemX + viewportC * itemY + viewportX
      const y = viewportB * itemX + viewportD * itemY + viewportY
      const fontSize = Math.hypot(transformedC, transformedD)
      // Malformed PDFs can carry degenerate matrices; fall back to a sane
      // position so the text is kept instead of corrupting the ordering.
      return {
        item,
        fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 1,
        pageX: Number.isFinite(x) ? x : 0,
        pageY: Number.isFinite(y) ? y : 0,
        width: Number.isFinite(item.width) ? item.width : 0,
        ...advanceAxis(advanceX, advanceY),
      }
    })

  // PDFs sometimes draw the same run twice in place (faux bold, duplicated
  // layers); keeping both would fuse the copies into one doubled token.
  const seenRuns = new Set<string>()
  const uniqueItems = orientedItems.filter((orientedItem) => {
    const key = `${Math.round(orientedItem.pageX * 4)},${Math.round(orientedItem.pageY * 4)},${orientedItem.item.str}`
    if (seenRuns.has(key)) {
      return false
    }
    seenRuns.add(key)
    return true
  })

  return orientationGroups(uniqueItems)
    .map((group) => {
      const positionedItems = attachInlineGlyphs(group
        .map(({ item, fontSize, width, pageX, pageY, advanceUnitX, advanceUnitY }) => ({
          item,
          fontSize,
          width,
          x: advanceUnitX * pageX + advanceUnitY * pageY,
          y: -advanceUnitY * pageX + advanceUnitX * pageY,
        })))
        .sort((left, right) => left.y - right.y || left.x - right.x)
      return readingBlocks(positionedItems)
        .map(block => renderBlock(block))
        .join('\n')
    })
    .filter(text => text.length > 0)
    .join('\n')
}

function attachInlineGlyphs(items: PositionedItem[]): PositionedItem[] {
  let attachedItems = [...items]
  const attachedItemSet = new Set(items)

  for (const radical of items.filter(item => item.item.str === '√')) {
    const radicalRight = radical.x + radical.width
    const radicand = attachedItems
      .filter(item =>
        item !== radical
        && item.item.str.trim().length > 0
        && item.item.str !== '√'
        && Math.abs(item.x - radicalRight) <= Math.max(0.5, radical.fontSize * 0.1)
        && Math.abs(item.y - radical.y) <= radical.fontSize,
      )
      .sort((left, right) =>
        Math.abs(left.x - radicalRight) - Math.abs(right.x - radicalRight)
        || Math.abs(left.y - radical.y) - Math.abs(right.y - radical.y),
      )
      .at(0)
    if (!radicand) {
      continue
    }

    attachedItems = attachedItems.filter(item => item !== radical && item !== radicand)
    attachedItemSet.delete(radical)
    attachedItemSet.delete(radicand)
    const attachedRadicand = {
      ...radicand,
      item: {
        ...radicand.item,
        str: radical.item.str + radicand.item.str,
        hasEOL: radical.item.hasEOL || radicand.item.hasEOL,
      },
      x: radical.x,
      width: Math.max(
        radical.x + radical.width,
        radicand.x + radicand.width,
      ) - radical.x,
    }
    attachedItems.push(attachedRadicand)
    attachedItemSet.add(attachedRadicand)
  }

  const maximumFontSize = Math.max(0, ...attachedItems.map(item => item.fontSize))
  let nextAttachmentOrder = 0
  const baseCandidates = attachedItems
    .map(item => ({
      item,
      order: nextAttachmentOrder++,
      right: item.x + item.width,
    }))
    .sort((left, right) => left.right - right.right || left.order - right.order)
  const candidates = attachedItems
    .filter(item => item.fontSize < maximumFontSize * 0.85)
    .sort(
      (left, right) => left.fontSize - right.fontSize,
    )
  for (const script of candidates) {
    if (!attachedItemSet.has(script) || script.item.str.trim().length === 0) {
      continue
    }

    const minimumRight = script.x - Math.max(0.75, maximumFontSize * 0.1)
    const maximumRight = script.x + 0.5
    let firstCandidate = 0
    let pastLastCandidate = baseCandidates.length
    while (firstCandidate < pastLastCandidate) {
      const middle = Math.floor((firstCandidate + pastLastCandidate) / 2)
      if (baseCandidates[middle]!.right < minimumRight) {
        firstCandidate = middle + 1
      }
      else {
        pastLastCandidate = middle
      }
    }
    let base: PositionedItem | undefined
    let baseDistance = Infinity
    let baseOrder = Infinity
    for (let candidateIndex = firstCandidate; candidateIndex < baseCandidates.length; candidateIndex++) {
      const candidateEntry = baseCandidates[candidateIndex]!
      if (candidateEntry.right > maximumRight) {
        break
      }
      const candidate = candidateEntry.item
      if (
        !attachedItemSet.has(candidate)
        || candidate === script
        || candidate.item.str.trim().length === 0
        || script.fontSize >= candidate.fontSize * 0.85
      ) {
        continue
      }

      const gap = script.x - candidateEntry.right
      const overlap = Math.min(candidate.y, script.y)
        - Math.max(candidate.y - candidate.fontSize, script.y - script.fontSize)
      if (
        gap < -0.5
        || gap > Math.max(0.75, candidate.fontSize * 0.1)
        || Math.abs(candidate.y - script.y) < script.fontSize * 0.15
        || overlap < script.fontSize * 0.5
      ) {
        continue
      }

      const distance = Math.abs(gap)
      if (distance < baseDistance || (distance === baseDistance && candidateEntry.order < baseOrder)) {
        base = candidate
        baseDistance = distance
        baseOrder = candidateEntry.order
      }
    }
    if (!base) {
      continue
    }

    attachedItems = attachedItems.filter(item => item !== base && item !== script)
    attachedItemSet.delete(base)
    attachedItemSet.delete(script)
    const attachedScript = {
      ...base,
      item: {
        ...base.item,
        str: base.item.str + script.item.str,
        hasEOL: base.item.hasEOL || script.item.hasEOL,
      },
      width: Math.max(
        base.x + base.width,
        script.x + script.width,
      ) - base.x,
    }
    attachedItems.push(attachedScript)
    attachedItemSet.add(attachedScript)
    const attachedScriptEntry = {
      item: attachedScript,
      order: nextAttachmentOrder++,
      right: attachedScript.x + attachedScript.width,
    }
    let insertionIndex = 0
    let insertionLimit = baseCandidates.length
    while (insertionIndex < insertionLimit) {
      const middle = Math.floor((insertionIndex + insertionLimit) / 2)
      const candidateEntry = baseCandidates[middle]!
      if (
        candidateEntry.right < attachedScriptEntry.right
        || (
          candidateEntry.right === attachedScriptEntry.right
          && candidateEntry.order < attachedScriptEntry.order
        )
      ) {
        insertionIndex = middle + 1
      }
      else {
        insertionLimit = middle
      }
    }
    baseCandidates.splice(insertionIndex, 0, attachedScriptEntry)
  }

  return attachedItems
}

interface OrientedItem {
  item: VisualOrderItem
  fontSize: number
  pageX: number
  pageY: number
  width: number
  advanceUnitX: number
  advanceUnitY: number
}

// Quantizes an item's advance direction to the nearest page axis. Sideways
// tables embedded in unrotated pages (common in financial reports) advance
// along the vertical axis and must be read in their own frame.
function advanceAxis(
  advanceX: number,
  advanceY: number,
): { advanceUnitX: number, advanceUnitY: number } {
  if (
    !Number.isFinite(advanceX) || !Number.isFinite(advanceY)
    || (advanceX === 0 && advanceY === 0)
  ) {
    return { advanceUnitX: 1, advanceUnitY: 0 }
  }
  if (Math.abs(advanceY) > Math.abs(advanceX)) {
    return { advanceUnitX: 0, advanceUnitY: Math.sign(advanceY) }
  }
  return { advanceUnitX: Math.sign(advanceX), advanceUnitY: 0 }
}

// Reading order between orientations follows their position on the page:
// whichever body of text starts higher is read first.
function orientationGroups(items: OrientedItem[]): OrientedItem[][] {
  const groups = new Map<string, OrientedItem[]>()
  for (const orientedItem of items) {
    const key = `${orientedItem.advanceUnitX},${orientedItem.advanceUnitY}`
    const group = groups.get(key) ?? []
    group.push(orientedItem)
    groups.set(key, group)
  }

  return [...groups.values()].sort((left, right) => {
    const top = (group: OrientedItem[]) =>
      Math.min(...group.map(item => item.pageY - item.fontSize))
    return top(left) - top(right)
  })
}

function readingBlocks(items: PositionedItem[]): PositionedItem[][] {
  if (items.length === 0) {
    return []
  }

  const blockGap = medianFontSize(items) * 1.5
  const containsDenseTable = inferDenseTableLayout(groupIntoLines(items)) !== undefined
  const stripes = containsDenseTable
    ? [items]
    : splitAtHorizontalGaps(items, blockGap)
  if (stripes.length > 1) {
    return stripes.flatMap(stripe => readingBlocks(stripe))
  }

  const sides = splitAtVerticalGutter(items, blockGap)
  if (!sides) {
    return [items]
  }

  return sides.flatMap(side => readingBlocks(side))
}

function medianFontSize(items: PositionedItem[]): number {
  const sizes = items.map(item => item.fontSize).sort((left, right) => left - right)
  return sizes[Math.floor(sizes.length / 2)] ?? 12
}

function splitAtHorizontalGaps(
  items: PositionedItem[],
  gapThreshold: number,
): PositionedItem[][] {
  const stripes: PositionedItem[][] = []
  let stripe: PositionedItem[] = []
  let stripeBottom = -Infinity

  for (const positionedItem of items) {
    const top = positionedItem.y - positionedItem.fontSize
    if (stripe.length > 0 && top - stripeBottom > gapThreshold) {
      stripes.push(stripe)
      stripe = []
    }
    stripe.push(positionedItem)
    stripeBottom = Math.max(stripeBottom, positionedItem.y)
  }
  if (stripe.length > 0) {
    stripes.push(stripe)
  }

  return stripes
}

function splitAtVerticalGutter(
  items: PositionedItem[],
  gutterThreshold: number,
): [PositionedItem[], PositionedItem[]] | undefined {
  const intervals = items
    .map(item => [item.x, item.x + item.width] as const)
    .sort((left, right) => left[0] - right[0])

  const gutters: Array<{ start: number, end: number }> = []
  let coverageEnd: number | undefined
  for (const [start, end] of intervals) {
    if (coverageEnd !== undefined && start - coverageEnd >= gutterThreshold) {
      gutters.push({ start: coverageEnd, end: start })
    }
    coverageEnd = coverageEnd === undefined ? end : Math.max(coverageEnd, end)
  }

  const widestFirst = gutters.sort(
    (left, right) => (right.end - right.start) - (left.end - left.start),
  )
  for (const gutter of widestFirst) {
    const left: PositionedItem[] = []
    const right: PositionedItem[] = []
    for (const positionedItem of items) {
      (positionedItem.x + positionedItem.width <= gutter.start ? left : right)
        .push(positionedItem)
    }
    if (looksLikeFacingColumns(left, right)) {
      return [left, right]
    }
  }

  return undefined
}

// Table rows share baselines across the gutter and must stay row-major,
// while prose columns drift apart through headings and paragraph spacing.
// Only cut when both sides are multi-line and their baselines disagree.
function looksLikeFacingColumns(
  left: PositionedItem[],
  right: PositionedItem[],
): boolean {
  const leftBaselines = distinctBaselines(left)
  const rightBaselines = distinctBaselines(right)
  if (leftBaselines.length < 4 || rightBaselines.length < 4) {
    return false
  }

  const alignedBaselineCount = leftBaselines
    .filter(baseline => rightBaselines.some(other => Math.abs(baseline - other) <= 1))
    .length
  if (alignedBaselineCount >= 3) {
    return false
  }

  const unalignedShare = (own: number[], facing: number[]) =>
    own.filter(baseline => !facing.some(other => Math.abs(baseline - other) <= 1)).length
    / own.length
  return Math.max(
    unalignedShare(leftBaselines, rightBaselines),
    unalignedShare(rightBaselines, leftBaselines),
  ) >= 0.3
}

function distinctBaselines(items: PositionedItem[]): number[] {
  const baselines: number[] = []
  for (const positionedItem of items) {
    const last = baselines.at(-1)
    if (last === undefined || positionedItem.y - last > 2) {
      baselines.push(positionedItem.y)
    }
  }
  return baselines
}

function renderBlock(blockItems: PositionedItem[]): string {
  const lines = groupIntoLines(blockItems)
  // Embedded font metrics can overstate run widths, so repeated x positions
  // are stronger evidence of a table boundary than the measured text gap.
  const columnBaselines = new Map<number, Set<number>>()
  for (const positionedItem of blockItems) {
    if (!/^\s*$/.test(positionedItem.item.str)) {
      const columnBucket = Math.round(positionedItem.x * 2)
      const baselines = columnBaselines.get(columnBucket) ?? new Set<number>()
      baselines.add(Math.round(positionedItem.y * 2))
      columnBaselines.set(columnBucket, baselines)
    }
  }

  const tableLayout = inferDenseTableLayout(lines)
  if (!tableLayout) {
    return lines.map(line => renderLine(line, columnBaselines)).join('\n')
  }

  const renderedLines: string[] = []
  let lineIndex = 0
  while (lineIndex < lines.length) {
    const tableRange = tableLayout.ranges.find(range => range.start === lineIndex)
    if (!tableRange) {
      renderedLines.push(renderLine(lines[lineIndex]!, columnBaselines))
      lineIndex++
      continue
    }

    const rangeLines = lines.slice(tableRange.start, tableRange.end + 1)
    const inferredRangeLayout = tableLayout.ranges.length > 1
      ? inferDenseTableLayout(rangeLines)
      : undefined
    const rangeIsSparseSubset = inferredRangeLayout
      && inferredRangeLayout.columnStarts.length < tableLayout.columnStarts.length
      && inferredRangeLayout.columnStarts.every(start =>
        tableLayout.columnStarts.some(tableStart =>
          Math.abs(start - tableStart)
          <= Math.max(inferredRangeLayout.positionTolerance, tableLayout.positionTolerance)))
    const rangeLayout = rangeIsSparseSubset
      ? tableLayout
      : inferredRangeLayout ?? tableLayout
    if (renderedLines.at(-1)?.includes('\t')) {
      renderedLines.push('')
    }
    const textBeforeTable = rangeLines
      .map(line => line.items.filter(item =>
        item.x < rangeLayout.tableStart - rangeLayout.positionTolerance))
      .filter(items => items.length > 0)
      .map(items => renderLine(
        {
          baseline: items[0]!.y,
          fontSize: Math.max(...items.map(item => item.fontSize)),
          top: Math.min(...items.map(item => item.y - item.fontSize)),
          items,
        },
        new Map(),
      ).replaceAll('\t', ' '))
      .filter(text => text.length > 0)
    renderedLines.push(...textBeforeTable)

    for (const line of rangeLines) {
      const tableItems = line.items.filter(item =>
        item.x >= rangeLayout.tableStart - rangeLayout.positionTolerance)
      if (tableItems.length === 0) {
        continue
      }
      renderedLines.push(renderTableLine(line, tableItems, rangeLayout))
    }
    lineIndex = tableRange.end + 1
  }

  return renderedLines.join('\n')
}

interface DenseTableLayout {
  columnStarts: number[]
  positionTolerance: number
  ranges: Array<{ start: number, end: number }>
  tableStart: number
}

function inferDenseTableLayout(lines: Line[]): DenseTableLayout | undefined {
  const candidateLines = lines.filter(line =>
    line.items.filter(item => item.item.str.trim().length > 0).length >= 4)
  if (candidateLines.length === 0) {
    return undefined
  }

  const candidateRuns = candidateLines.flatMap(line => line.items)
    .filter(item => item.item.str.trim().length > 0)
  // Aligned prose can resemble table rows. Numeric density is the extra
  // evidence required before using the narrow-grid heuristics.
  const numericShare = candidateRuns.filter(item => /\d/.test(item.item.str)).length
    / candidateRuns.length
  const numericTableTokenCount = candidateRuns.filter(item =>
    isNumericTableToken(item.item.str)).length
  const numericTableShare = numericTableTokenCount / candidateRuns.length
  if (
    numericShare < 0.15
    || numericTableShare < 0.3
    || (candidateLines.length === 1
      && (candidateRuns.length < 6
        || numericShare < 0.5
        || numericTableTokenCount < candidateRuns.length - 1))
  ) {
    return undefined
  }

  const fontCounts = new Map<number, number>()
  for (const line of candidateLines) {
    for (const positionedItem of line.items) {
      if (positionedItem.item.str.trim().length === 0) {
        continue
      }
      const fontBucket = Math.round(positionedItem.fontSize * 10)
      fontCounts.set(fontBucket, (fontCounts.get(fontBucket) ?? 0) + 1)
    }
  }
  const dominantFontBucket = [...fontCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0]
  if (dominantFontBucket === undefined) {
    return undefined
  }

  const dominantFontSize = dominantFontBucket / 10
  const fontTolerance = Math.max(0.05, dominantFontSize * 0.04)
  const positionTolerance = Math.max(0.5, dominantFontSize * 0.6)
  const candidateRows = lines.map(line => line.items.filter(item =>
    item.item.str.trim().length > 0
    && Math.abs(item.fontSize - dominantFontSize) <= fontTolerance))
    .filter(items => items.length >= 4)
  if (candidateRows.length === 0) {
    return undefined
  }
  const numericRows = candidateRows.filter(row =>
    numericRunCount(row) >= Math.max(2, Math.ceil(row.length / 4)))
  const representativeRows = numericRows.length > 0 ? numericRows : candidateRows
  const rowLengthCounts = new Map<number, number>()
  for (const row of representativeRows) {
    rowLengthCounts.set(row.length, (rowLengthCounts.get(row.length) ?? 0) + 1)
  }
  const repeatedLengths = [...rowLengthCounts.entries()]
    .filter(([, occurrenceCount]) => occurrenceCount >= 2)
    .sort((left, right) => right[0] - left[0])
  const widestNumericRow = [...representativeRows]
    .sort((left, right) => right.length - left.length)[0]!
  const repeatedLength = repeatedLengths[0]?.[0]
  const isolatedWideRecord = widestNumericRow.length >= 4
    && numericRunCount(widestNumericRow) >= Math.ceil(widestNumericRow.length / 3)
    && (repeatedLength === undefined
      || widestNumericRow.length >= Math.ceil(repeatedLength * 1.5))
  const mostFrequentLength = [...rowLengthCounts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]![0]
  const representativeLength = isolatedWideRecord
    ? widestNumericRow.length
    : repeatedLength ?? mostFrequentLength
  const representativeRow = representativeRows
    .filter(items => items.length === representativeLength)
    .sort((left, right) =>
      numericRunCount(right) - numericRunCount(left))[0]!
  let columnStarts = representativeRow
    .map(tablePosition)
    .sort((left, right) => left - right)
  if (columnStarts.length < 4) {
    return undefined
  }

  const inferredInteriorColumns: number[] = []
  const hasRepeatedIsoDateColumns = candidateRuns
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.item.str.trim()))
    .length >= 2
  if (hasRepeatedIsoDateColumns) {
    for (let gapIndex = 0; gapIndex < columnStarts.length - 1; gapIndex++) {
      const gapStart = columnStarts[gapIndex]!
      const gapEnd = columnStarts[gapIndex + 1]!
      const gapCandidates = lines.flatMap(line => line.items)
        .filter(item =>
          item.item.str.trim().length >= 20
          && Math.abs(item.fontSize - dominantFontSize) <= fontTolerance
          && item.x > gapStart + positionTolerance * 2
          && item.x < gapEnd - positionTolerance * 2)
        .sort((left, right) => left.x - right.x)
      const clusters: PositionedItem[][] = []
      for (const candidate of gapCandidates) {
        const cluster = clusters.at(-1)
        if (
          !cluster
          || candidate.x - cluster.at(-1)!.x > positionTolerance * 2
        ) {
          clusters.push([candidate])
        }
        else {
          cluster.push(candidate)
        }
      }
      const wrappedTextColumn = clusters
        .filter(cluster => cluster.length >= 3)
        .sort((left, right) => {
          const characterCount = (cluster: PositionedItem[]) =>
            cluster.reduce((total, item) => total + item.item.str.length, 0)
          return characterCount(right) - characterCount(left)
        })
        .at(0)
      if (wrappedTextColumn) {
        inferredInteriorColumns.push(wrappedTextColumn[0]!.x)
      }
    }
  }
  columnStarts = [...columnStarts, ...inferredInteriorColumns]
    .sort((left, right) => left - right)

  const representativeStart = Math.min(...representativeRow.map(item => item.x))
  let tableStart = representativeStart
  const representativeRowCount = candidateRows.filter(row =>
    row.length === representativeLength).length
  const requiredLeadingOccurrences = Math.min(4, representativeRowCount)
  const leadingCandidates = lines.flatMap(line => line.items)
    .filter(item => item.x < representativeStart - positionTolerance)
  const repeatedLeadingColumn = leadingCandidates
    .map(candidate => ({
      candidate,
      occurrences: lines.flatMap(line => line.items).filter(item =>
        Math.abs(item.x - candidate.x) <= positionTolerance).length,
    }))
    .filter(({ candidate, occurrences }) =>
      occurrences >= 4
      || (occurrences >= requiredLeadingOccurrences
        && candidate.x + candidate.width >= representativeStart - positionTolerance))
    .sort((left, right) => right.candidate.x - left.candidate.x)
    .at(0)
    ?.candidate
  if (repeatedLeadingColumn) {
    const alignsWithCenteredFirstColumn = repeatedLeadingColumn.x + repeatedLeadingColumn.width
      >= representativeStart - positionTolerance
    columnStarts = alignsWithCenteredFirstColumn
      ? [repeatedLeadingColumn.x, ...columnStarts.slice(1)]
      : [repeatedLeadingColumn.x, ...columnStarts]
    tableStart = repeatedLeadingColumn.x
  }

  const wideHeaderRow = candidateRows
    .filter(row =>
      row.length > columnStarts.length
      && numericRunCount(row) < Math.ceil(row.length / 2))
    .map(row => ({
      row,
      positions: row
        .map(item => item.x + item.width / 2)
        .sort((left, right) => left - right),
    }))
    .filter(({ positions }) => {
      const alignedColumns = positions.filter(position =>
        columnStarts.some(start => Math.abs(start - position) <= positionTolerance * 2))
      return alignedColumns.length >= Math.min(3, columnStarts.length)
    })
    .sort((left, right) => right.row.length - left.row.length)[0]
  const missingLeadingColumns = wideHeaderRow?.positions
    .filter(position => position < columnStarts[0]! - positionTolerance)
    .filter((position, positionIndex, positions) =>
      positionIndex === 0 || position - positions[positionIndex - 1]! > positionTolerance)
  const headerDefinesWiderGrid = wideHeaderRow
    && wideHeaderRow.positions.length >= columnStarts.length + 2
  if (headerDefinesWiderGrid || (missingLeadingColumns && missingLeadingColumns.length > 0)) {
    if (headerDefinesWiderGrid) {
      const alignmentOffset = Array.from(
        { length: wideHeaderRow.positions.length - columnStarts.length + 1 },
        (_, offset) => ({
          offset,
          distance: columnStarts.reduce((total, start, columnIndex) =>
            total + Math.abs(start - wideHeaderRow.positions[offset + columnIndex]!), 0),
        }),
      ).sort((left, right) => left.distance - right.distance)[0]!.offset
      columnStarts = [
        ...wideHeaderRow.positions.slice(0, alignmentOffset),
        ...columnStarts,
        ...wideHeaderRow.positions.slice(alignmentOffset + columnStarts.length),
      ]
    }
    else {
      columnStarts = [...missingLeadingColumns!, ...columnStarts]
    }
    const firstColumnGap = columnStarts[1]! - columnStarts[0]!
    const firstColumnBoundary = columnStarts[0]! - firstColumnGap / 2
    tableStart = Math.min(tableStart, firstColumnBoundary)
  }

  const minimumColumnGap = Math.min(...columnStarts.slice(1)
    .map((start, index) => start - columnStarts[index]!))
  const matchTolerance = Math.max(positionTolerance, minimumColumnGap * 0.45)

  const matchedColumns = lines.map((line) => {
    const matches = new Set<number>()
    for (const positionedItem of line.items) {
      const position = tablePosition(positionedItem)
      const columnIndex = nearestColumnIndex(position, columnStarts)
      if (Math.abs(position - columnStarts[columnIndex]!) <= matchTolerance) {
        matches.add(columnIndex)
      }
    }
    return matches.size
  })

  const tableBreaks = new Set<number>()
  for (let lineIndex = 1; lineIndex < lines.length - 1; lineIndex++) {
    const previousLine = lines[lineIndex - 1]!
    const line = lines[lineIndex]!
    const labelItems = line.items.filter(item => item.item.str.trim().length > 0)
    const precedingNumericCells = previousLine.items.filter(item =>
      isNumericTableToken(item.item.str)).length
    const followedByNumericGrid = lines.slice(lineIndex + 1, lineIndex + 4)
      .some(candidate =>
        candidate.items.length >= 4
        && candidate.items.filter(item => isNumericTableToken(item.item.str)).length >= 2)
    if (
      line.baseline - previousLine.baseline
      > Math.max(line.fontSize, previousLine.fontSize) * 2.2
      && precedingNumericCells >= 2
      && labelItems.length >= 4
      && labelItems.every(item => !isNumericTableToken(item.item.str))
      && labelItems.filter(item => /[a-z]/i.test(item.item.str)).length >= 2
      && followedByNumericGrid
    ) {
      tableBreaks.add(lineIndex)
    }
  }

  const ranges: Array<{ start: number, end: number }> = []
  let rangeStart: number | undefined
  let lastTableLine: number | undefined
  let misses = 0
  for (const [index, matchCount] of matchedColumns.entries()) {
    if (matchCount >= 4) {
      if (rangeStart === undefined) {
        rangeStart = index
        while (rangeStart > 0 && matchedColumns[rangeStart - 1]! > 0) {
          const precedingLine = lines[rangeStart - 1]!
          const firstRangeLine = lines[rangeStart]!
          const precedingItems = precedingLine.items.filter(item =>
            item.item.str.trim().length > 0)
          const precedingHeaderRow = matchedColumns[rangeStart - 1]! >= 1
            && precedingItems.length >= 2
            && precedingItems.every(item => !isNumericTableToken(item.item.str))
          const precedingGapLimit = Math.max(firstRangeLine.fontSize, precedingLine.fontSize)
            * (precedingHeaderRow ? 3.5 : 2.2)
          if (
            (!precedingHeaderRow
              && Math.abs(precedingLine.fontSize - dominantFontSize) > fontTolerance)
            || firstRangeLine.baseline - precedingLine.baseline
            > precedingGapLimit
          ) {
            break
          }
          rangeStart--
        }
      }
      lastTableLine = index
      misses = 0
      continue
    }
    if (rangeStart === undefined) {
      continue
    }
    const previousLine = lines[index - 1]
    const line = lines[index]!
    const followsTableLine = previousLine
      && lastTableLine === index - 1
      && line.baseline - previousLine.baseline
      <= Math.max(line.fontSize, previousLine.fontSize) * 2.2
    const nextTableLine = lines.slice(index + 1).findIndex((candidateLine, offset) => {
      const baselineGap = candidateLine.baseline - line.baseline
      const gapLimit = Math.max(line.fontSize, candidateLine.fontSize) * 8
      return baselineGap <= gapLimit && matchedColumns[index + offset + 1]! > 0
    })
    const bridgesTableRows = previousLine
      && nextTableLine >= 0
      && line.baseline - previousLine.baseline
      <= Math.max(line.fontSize, previousLine.fontSize) * 8
    const continuationItems = line.items.filter(item => item.item.str.trim().length > 0)
    const wrappedTableCell = matchCount === 0
      && followsTableLine
      && nextTableLine >= 0
      && continuationItems.length <= 2
    if ((matchCount > 0 && (followsTableLine || bridgesTableRows)) || wrappedTableCell) {
      lastTableLine = index
      misses = 0
      continue
    }
    misses++
    if (misses <= 1) {
      continue
    }
    ranges.push({ start: rangeStart, end: lastTableLine! })
    rangeStart = undefined
    lastTableLine = undefined
    misses = 0
  }
  if (rangeStart !== undefined && lastTableLine !== undefined) {
    ranges.push({ start: rangeStart, end: lastTableLine })
  }
  if (tableBreaks.size > 0) {
    const boundaries = [0, ...tableBreaks, lines.length]
    const separatedRanges = boundaries.slice(0, -1).flatMap((start, boundaryIndex) => {
      const end = boundaries[boundaryIndex + 1]!
      const segmentLayout = inferDenseTableLayout(lines.slice(start, end))
      return segmentLayout?.ranges.map((range, rangeIndex) => ({
        start: boundaryIndex > 0 && rangeIndex === 0 ? start : start + range.start,
        end: start + range.end,
      })) ?? []
    })
    if (separatedRanges.length >= 2) {
      ranges.splice(0, ranges.length, ...separatedRanges)
    }
  }
  if (ranges.length === 0) {
    return undefined
  }

  return { columnStarts, positionTolerance, ranges, tableStart }
}

function numericRunCount(items: PositionedItem[]): number {
  return items.filter(item => /\d/.test(item.item.str)).length
}

function tablePosition(positionedItem: PositionedItem): number {
  if (
    isNumericTableToken(positionedItem.item.str)
    || positionedItem.width <= positionedItem.fontSize * 4
  ) {
    return positionedItem.x + positionedItem.width / 2
  }
  return positionedItem.x
}

function isNumericTableToken(text: string): boolean {
  return /^(?:(?:[+\-]?\$?\(?\d[\d,]*(?:\.\d+)?%?\)?|\d+\/\d+|\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\s*\*?|[-–—])$/.test(text.trim())
}

function nearestColumnIndex(position: number, columnStarts: number[]): number {
  let columnIndex = 0
  let columnDistance = Infinity
  for (const [index, start] of columnStarts.entries()) {
    const distance = Math.abs(start - position)
    if (distance < columnDistance) {
      columnIndex = index
      columnDistance = distance
    }
  }
  return columnIndex
}

function renderTableLine(
  line: Line,
  positionedItems: PositionedItem[],
  layout: DenseTableLayout,
): string {
  const columnItems = layout.columnStarts.map(() => [] as PositionedItem[])
  const visibleItems = positionedItems.filter(item => item.item.str.trim().length > 0)
  const centersHeaderLabels = visibleItems.length >= 2
    && visibleItems.every(item => !isNumericTableToken(item.item.str))
    && visibleItems.filter(item => /[a-z]/i.test(item.item.str)).length >= 2
  for (const positionedItem of positionedItems) {
    const columnIndex = nearestColumnIndex(
      centersHeaderLabels
        ? positionedItem.x + positionedItem.width / 2
        : tablePosition(positionedItem),
      layout.columnStarts,
    )
    columnItems[columnIndex]!.push(positionedItem)
  }

  return columnItems.map(items => items.length === 0
    ? ''
    : renderLine({ ...line, items }, new Map()).replaceAll('\t', ' '))
    .join('\t')
    .trimEnd()
}

function groupIntoLines(positionedItems: PositionedItem[]): Line[] {
  const lines: Line[] = []

  for (const positionedItem of positionedItems) {
    const line = lines.at(-1)
    if (!line || !belongsToLine(line, positionedItem)) {
      lines.push({
        baseline: positionedItem.y,
        fontSize: positionedItem.fontSize,
        top: positionedItem.y - positionedItem.fontSize,
        items: [positionedItem],
      })
      continue
    }

    line.items.push(positionedItem)
    line.top = Math.min(line.top, positionedItem.y - positionedItem.fontSize)
    if (positionedItem.fontSize > line.fontSize) {
      line.fontSize = positionedItem.fontSize
      line.baseline = positionedItem.y
    }
  }

  return lines
}

function belongsToLine(line: Line, positionedItem: PositionedItem): boolean {
  const baselineTolerance = Math.max(
    0.5,
    Math.min(line.fontSize, positionedItem.fontSize) * 0.25,
  )
  if (Math.abs(line.baseline - positionedItem.y) <= baselineTolerance) {
    return true
  }

  // Superscripts and subscripts sit off the shared baseline but still
  // overlap most of the line's vertical extent.
  const overlap = Math.min(line.baseline, positionedItem.y)
    - Math.max(line.top, positionedItem.y - positionedItem.fontSize)
  return overlap >= Math.min(line.fontSize, positionedItem.fontSize) * 0.5
}

interface RenderedRun {
  text: string
  /** Separator between this run and its visual left neighbor. */
  separator: string
  rtl: boolean
}

function renderLine(line: Line, columnBaselines: Map<number, Set<number>>): string {
  line.items.sort((left, right) => left.x - right.x)

  const runs: RenderedRun[] = []
  let rightEdge: number | undefined
  let previousFontSize: number | undefined
  let previousY: number | undefined
  let previousText: string | undefined
  let previousHasEOL = false
  let pendingWhitespace = false
  for (const positionedItem of line.items) {
    const itemText = positionedItem.item.str
    // Whitespace-only runs mark a separator, but its kind (space or tab) is
    // decided by the geometric gap between the visible neighbors.
    if (/^\s+$/.test(itemText)) {
      pendingWhitespace = true
      continue
    }

    const gap = rightEdge === undefined ? 0 : positionedItem.x - rightEdge
    const seamFontSize = Math.min(
      previousFontSize ?? positionedItem.fontSize,
      positionedItem.fontSize,
    )

    // Table columns repeat an x position to sub-point precision; a looser
    // match would also catch coincidentally similar word seams.
    const columnBucket = Math.round(positionedItem.x * 2)
    const ownBaseline = Math.round(positionedItem.y * 2)
    const alignedBaselines = new Set<number>()
    for (let nearbyBucket = columnBucket - 2; nearbyBucket <= columnBucket + 2; nearbyBucket++) {
      for (const baseline of columnBaselines.get(nearbyBucket) ?? []) {
        if (baseline !== ownBaseline) {
          alignedBaselines.add(baseline)
        }
      }
    }

    const followsWordGap = gap > seamFontSize * 0.1
    // Column evidence exists for cells whose overstated font metrics overlap
    // the next column. A seam within kerning distance of touching is
    // intra-word (small caps, kerned splits), however well it aligns.
    const overlapsBeyondKerning = gap < -seamFontSize * 0.1
    const startsAlignedColumn = overlapsBeyondKerning && alignedBaselines.size >= 2
    // A line that opens with a small raised run is a footnote marker
    // defining the note, not a superscript continuing a word.
    const leadingFootnoteMarker = runs.length === 1
      && previousFontSize !== undefined
      && previousY !== undefined
      && previousFontSize <= positionedItem.fontSize * 0.8
      && previousY < positionedItem.y - positionedItem.fontSize * 0.2

    const wantsSeparator = runs.length > 0
      && !/[\t ]$/.test(previousText ?? '')
      && (pendingWhitespace || previousHasEOL || followsWordGap || startsAlignedColumn || leadingFootnoteMarker)

    runs.push({
      text: itemText,
      separator: wantsSeparator ? (gap > seamFontSize * 2 ? '\t' : ' ') : '',
      rtl: positionedItem.item.dir === 'rtl',
    })
    pendingWhitespace = false
    previousText = itemText
    previousHasEOL = positionedItem.item.hasEOL ?? false
    rightEdge = positionedItem.x + positionedItem.width
    previousFontSize = positionedItem.fontSize
    previousY = positionedItem.y
  }

  return joinRuns(runs).trimEnd()
}

// PDF.js stores right-to-left runs in logical order, so a contiguous
// right-to-left sequence reads from its visually rightmost run backwards.
function joinRuns(runs: RenderedRun[]): string {
  const groups: Array<{ rtl: boolean, runs: RenderedRun[] }> = []
  for (const renderedRun of runs) {
    const group = groups.at(-1)
    if (group && group.rtl === renderedRun.rtl) {
      group.runs.push(renderedRun)
      continue
    }
    groups.push({ rtl: renderedRun.rtl, runs: [renderedRun] })
  }

  let text = ''
  for (const group of groups) {
    text += group.runs.at(0)?.separator ?? ''
    if (!group.rtl) {
      for (const [index, renderedRun] of group.runs.entries()) {
        text += (index === 0 ? '' : renderedRun.separator) + renderedRun.text
      }
      continue
    }

    const rightmostFirst = [...group.runs].reverse()
    for (const [index, renderedRun] of rightmostFirst.entries()) {
      text += renderedRun.text
      if (index < rightmostFirst.length - 1) {
        text += renderedRun.separator
      }
    }
  }

  return text
}
