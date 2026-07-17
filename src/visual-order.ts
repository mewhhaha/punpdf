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
    attachedItems.push({
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
    })
  }

  const candidates = [...attachedItems].sort(
    (left, right) => left.fontSize - right.fontSize,
  )
  for (const script of candidates) {
    if (!attachedItems.includes(script) || script.item.str.trim().length === 0) {
      continue
    }

    const base = attachedItems
      .filter((candidate) => {
        if (
          candidate === script
          || candidate.item.str.trim().length === 0
          || script.fontSize >= candidate.fontSize * 0.85
        ) {
          return false
        }

        const gap = script.x - (candidate.x + candidate.width)
        const overlap = Math.min(candidate.y, script.y)
          - Math.max(candidate.y - candidate.fontSize, script.y - script.fontSize)
        return gap >= -0.5
          && gap <= Math.max(0.75, candidate.fontSize * 0.1)
          && Math.abs(candidate.y - script.y) >= script.fontSize * 0.15
          && overlap >= script.fontSize * 0.5
      })
      .sort((left, right) =>
        Math.abs(script.x - left.x - left.width)
        - Math.abs(script.x - right.x - right.width),
      )
      .at(0)
    if (!base) {
      continue
    }

    attachedItems = attachedItems.filter(item => item !== base && item !== script)
    attachedItems.push({
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
    })
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
  const stripes = splitAtHorizontalGaps(items, blockGap)
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

  return groupIntoLines(blockItems)
    .map(line => renderLine(line, columnBaselines))
    .join('\n')
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
