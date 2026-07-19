import type { DocumentInitParameters, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import type { StructuredTextItem } from './text'
import { createIsomorphicCanvasFactory, renderPageAsImage } from './image'
import { extractText, extractTextItems } from './text'
import { getDocumentProxy, isPDFDocumentProxy } from './utils'

export interface ExtractHTMLOptions {
  mergePages?: boolean
  preserveLayout?: {
    canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>
    scale?: number
  }
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
  const { mergePages = false, preserveLayout } = options
  const ownsDocument = !isPDFDocumentProxy(data)
  const CanvasFactory = preserveLayout
    ? await createIsomorphicCanvasFactory(preserveLayout.canvasImport)
    : undefined
  const document = ownsDocument
    ? await getDocumentProxy(data, CanvasFactory ? { CanvasFactory } : {})
    : data
  const layoutDocument = preserveLayout && !ownsDocument
    ? await getDocumentProxy(await document.getData(), { CanvasFactory })
    : document
  let extractedText: { totalPages: number, text: string[] }
  let extractedItems: Awaited<ReturnType<typeof extractTextItems>>
  let pageImages: string[] | undefined

  try {
    extractedText = await extractText(document, { readingOrder: 'visual' })
    extractedItems = await extractTextItems(document)
    if (preserveLayout) {
      pageImages = []
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        pageImages.push(await renderPageAsImage(layoutDocument, pageNumber, {
          canvasImport: preserveLayout.canvasImport,
          scale: preserveLayout.scale,
          toDataURL: true,
        }))
      }
    }
  }
  finally {
    if (layoutDocument !== document) {
      await layoutDocument.cleanup()
    }
    if (ownsDocument) {
      await document.cleanup()
    }
  }
  const { text, totalPages } = extractedText
  const repeatedNavigationCounts = new Map<string, number>()
  for (const pageText of text) {
    const leadingLines = pageText.split('\n').slice(0, 4)
    const navigationLines = new Set(leadingLines.filter((line, lineIndex) => {
      const cells = line.split('\t').map(cell => cell.trim()).filter(Boolean)
      const followingLines = leadingLines.slice(lineIndex + 1, lineIndex + 3)
      const hasPageNumberLine = followingLines.some(followingLine =>
        followingLine.includes('\t')
        && followingLine.split('\t').some(cell => /^\d{1,4}$/.test(cell.trim())))
      return cells.length >= 4
        && cells.every(cell => /[a-z]/i.test(cell) && cell.length <= 40)
        && hasPageNumberLine
    }))
    for (const navigationLine of navigationLines) {
      repeatedNavigationCounts.set(
        navigationLine,
        (repeatedNavigationCounts.get(navigationLine) ?? 0) + 1,
      )
    }
  }
  const repeatedNavigationThreshold = Math.max(3, Math.ceil(totalPages / 2))
  const repeatedNavigationLines = new Set(
    [...repeatedNavigationCounts]
      .filter(([, pageCount]) => pageCount >= repeatedNavigationThreshold)
      .map(([navigationLine]) => navigationLine),
  )
  const structuredPages = text.map((pageText, pageIndex) => {
    let lines = pageText.split('\n')
    const pageItems = extractedItems.items[pageIndex] ?? []
    const navigationLineIndex = lines.findIndex((line, lineIndex) =>
      lineIndex < 3 && repeatedNavigationLines.has(line))
    if (navigationLineIndex >= 0) {
      const pageNumberLineIndex = lines.findIndex((line, lineIndex) =>
        lineIndex > navigationLineIndex
        && lineIndex <= navigationLineIndex + 2
        && line.includes('\t')
        && line.split('\t').some(cell => /^\d{1,4}$/.test(cell.trim())))
      if (pageNumberLineIndex >= 0) {
        const pageNumber = lines[pageNumberLineIndex]!
          .split('\t')
          .map(cell => cell.trim())
          .find(cell => /^\d{1,4}$/.test(cell))
        const pageNumberText = pageItems
          .filter(textRun => textRun.str === pageNumber)
          .sort((left, right) => right.y - left.y)[0]
        if (pageNumberText) {
          const furnitureBoundary = pageNumberText.y - pageNumberText.fontSize * 0.5
          for (let textIndex = pageItems.length - 1; textIndex >= 0; textIndex--) {
            if (pageItems[textIndex]!.y >= furnitureBoundary) {
              pageItems.splice(textIndex, 1)
            }
          }
        }
        lines = lines.slice(pageNumberLineIndex + 1)
      }
    }

    const misdecodedCheckmarks = pageItems.filter(textRun => textRun.str === 'ü')
    const checkmarkColumns = misdecodedCheckmarks.map(textRun => textRun.x)
    const checkmarkColumnSpan = checkmarkColumns.length > 0
      ? Math.max(...checkmarkColumns) - Math.min(...checkmarkColumns)
      : Infinity
    const maximumCheckmarkFontSize = Math.max(
      0,
      ...misdecodedCheckmarks.map(textRun => textRun.fontSize),
    )
    if (
      misdecodedCheckmarks.length >= 2
      && checkmarkColumnSpan <= maximumCheckmarkFontSize * 2
    ) {
      for (const textRun of misdecodedCheckmarks) {
        textRun.str = '✓'
      }
      lines = lines.map(line => line.replace(/(^|\t)ü(?=\s)/g, '$1✓'))
    }

    const numberedOutlineEntries = lines.flatMap((line, lineIndex) => {
      const marker = /^(\d+)[.)]?\s+(\S.*)$/.exec(line)
      return marker ? [{ lineIndex, ordinal: Number(marker[1]), text: marker[2]! }] : []
    })
    const alphabeticOutlineEntries = lines.flatMap((line, lineIndex) => {
      const marker = /^([a-z])[.)]\s+(\S.*)$/i.exec(line)
      return marker ? [{ lineIndex, ordinal: marker[1]!.toLowerCase().charCodeAt(0) - 96, text: marker[2]! }] : []
    })
    const numberedOutlineIsSequential = numberedOutlineEntries.every((entry, entryIndex) =>
      entryIndex === 0
      || entry.ordinal === numberedOutlineEntries[entryIndex - 1]!.ordinal + 1)
    const numberedOutlineHasDescriptions = numberedOutlineEntries.every(entry =>
      /[a-z]/i.test(entry.text))
    const numberedOutlineStartsAtOne = numberedOutlineEntries[0]?.ordinal === 1
    const hasNumberedOutline = numberedOutlineEntries.length >= 4
      && numberedOutlineIsSequential
      && numberedOutlineHasDescriptions
      && numberedOutlineStartsAtOne
    const hasHierarchicalOutline = numberedOutlineEntries.length >= 2
      && numberedOutlineIsSequential
      && numberedOutlineHasDescriptions
      && numberedOutlineStartsAtOne
      && alphabeticOutlineEntries.length >= 2
      && alphabeticOutlineEntries.every(entry =>
        numberedOutlineEntries.some(parent => parent.lineIndex < entry.lineIndex))

    if (hasNumberedOutline || hasHierarchicalOutline) {
      for (const entry of numberedOutlineEntries) {
        lines[entry.lineIndex] = `${entry.ordinal}. ${entry.text}`
      }
    }
    if (hasHierarchicalOutline) {
      for (const entry of alphabeticOutlineEntries) {
        lines[entry.lineIndex]
          = `   ${String.fromCharCode(96 + entry.ordinal)}. ${entry.text}`
      }
    }
    const fontSizesByText = new Map<string, number[]>()
    const itemsByText = new Map<string, typeof pageItems>()
    for (const item of pageItems) {
      const sizes = fontSizesByText.get(item.str) ?? []
      sizes.push(item.fontSize)
      fontSizesByText.set(item.str, sizes)
      const matchingItems = itemsByText.get(item.str) ?? []
      matchingItems.push(item)
      itemsByText.set(item.str, matchingItems)
    }
    const pageFontSizes = [...fontSizesByText.values()]
      .flat()
      .sort((left, right) => left - right)
    const medianPageFontSize = pageFontSizes[Math.floor(pageFontSizes.length / 2)] ?? 0
    const visiblePageBaselines = pageItems
      .filter(item => item.str.trim().length > 0)
      .map(item => item.y)
    const bottomPageBaseline = Math.min(...visiblePageBaselines)
    const topPageBaseline = Math.max(...visiblePageBaselines)
    const isPageFooterText = (value: string) => {
      const matchingItems = itemsByText.get(value) ?? []
      return matchingItems.length > 0
        && matchingItems.every(item =>
          item.y <= bottomPageBaseline + (topPageBaseline - bottomPageBaseline) * 0.08)
    }
    const rawTableRunCount = lines.reduce((count, line, sourceLineIndex) =>
      count + Number(line.includes('\t') && !(lines[sourceLineIndex - 1] ?? '').includes('\t')), 0)
    const maximumRawColumnCount = Math.max(
      0,
      ...lines.filter(line => line.includes('\t')).map(line => line.split('\t').length),
    )
    const sparseAxisLineCount = lines.filter((line) => {
      const values = line.split('\t').map(value => value.trim()).filter(Boolean)
      const axisValues = values.filter(value =>
        /^(?:\$?[\d,.]+%?|[A-Z][a-z]{2})$/.test(value))
      return values.length > 0
        && values.length <= 4
        && axisValues.length >= Math.ceil(values.length * 0.7)
    }).length
    const hasDenseSpatialCharts = lines.length >= 80
      && rawTableRunCount >= 8
      && maximumRawColumnCount >= 12
      && sparseAxisLineCount >= 15
    const fragmentedFinancialRowCount = lines.filter((line) => {
      const cells = line.split('\t').map(cell => cell.trim()).filter(Boolean)
      const wordCells = cells.filter((cell) => {
        const words = cell.match(/[a-z]+/gi) ?? []
        return /^[a-z][a-z' -]*[a-z:]$/i.test(cell) && words.length <= 2
      })
      const numericCells = cells.filter(cell =>
        /^(?:[$–—-]|\(?\d[\d,.]*%?\)?)$/.test(cell))
      return wordCells.length >= 4 && numericCells.length >= 2
    }).length
    const hasFragmentedFinancialTable = maximumRawColumnCount >= 10
      && fragmentedFinancialRowCount >= 2
      && medianPageFontSize >= 6
    const ordinalScheduleRowCount = lines.filter(line =>
      /(?:^|\t)\d+(?:st|nd|rd|th)(?:\t|$)/i.test(line)).length
    const scheduleDescriptionCount = lines.filter(line =>
      /\bafter public disclosure of\b/i.test(line)).length
    const hasFragmentedSchedule = ordinalScheduleRowCount >= 3
      && scheduleDescriptionCount >= 3
    let detachedLabelRunLength = 0
    let detachedLabelRunHasHierarchy = false
    let hasDetachedTableLabels = false
    for (let sourceLineIndex = 0; sourceLineIndex < lines.length; sourceLineIndex++) {
      const sourceLine = lines[sourceLineIndex]!
      if (!sourceLine.includes('\t')) {
        const words = sourceLine.match(/[a-z][a-z'-]*/gi) ?? []
        const isDetachedLabel = sourceLine.length <= 60
          && words.length >= 1
          && words.length <= 8
          && !/[.!?;]$/.test(sourceLine)
        detachedLabelRunLength = isDetachedLabel ? detachedLabelRunLength + 1 : 0
        detachedLabelRunHasHierarchy = isDetachedLabel
          ? detachedLabelRunHasHierarchy || /^Level \d+\b/i.test(sourceLine)
          : false
        continue
      }

      let unlabeledValueRowCount = 0
      for (
        let tableLineIndex = sourceLineIndex;
        tableLineIndex < lines.length && lines[tableLineIndex]!.includes('\t');
        tableLineIndex++
      ) {
        const tableValues = lines[tableLineIndex]!
          .split('\t')
          .map(value => value.trim())
          .filter(Boolean)
        if (
          tableValues.length >= 3
          && tableValues.every(value => /^(?:[$–—-]|\(?[\d,.]+%?\)?)$/.test(value))
        ) {
          unlabeledValueRowCount++
        }
      }
      if (
        detachedLabelRunLength >= 6
        && detachedLabelRunHasHierarchy
        && unlabeledValueRowCount >= 3
      ) {
        hasDetachedTableLabels = true
        break
      }
      detachedLabelRunLength = 0
      detachedLabelRunHasHierarchy = false
    }
    const detachedExhibitIdentifierCount = lines.filter(line => /^\d+\.\d+$/.test(line)).length
    const hasDetachedExhibitIdentifiers = detachedExhibitIdentifierCount >= 5
      && maximumRawColumnCount >= 3
    const signatureRowCount = lines.filter(line => line.includes('/s/')).length
    const hasFragmentedSignatures = lines.some(line => /^SIGNATURES$/i.test(line))
      && signatureRowCount >= 3
    const rawTabularRows = lines
      .filter(line => line.includes('\t'))
      .map(line => line.split('\t').map(cell => cell.trim()))
    const rawTabularCells = rawTabularRows.flatMap(row => row.filter(Boolean))
    const narrativeTableCellCount = rawTabularCells.filter(cell =>
      (cell.match(/[a-z][a-z'-]*/gi) ?? []).length >= 4).length
    const directoryLabelCellCount = rawTabularCells.filter(cell =>
      (cell.match(/[a-z][a-z'-]*/gi) ?? []).length >= 2).length
    const numericTableCellCount = rawTabularCells.filter(cell =>
      /^(?:[$–—-]|\(?\d[\d,.]*%?\)?)$/.test(cell)).length
    let placeholderFinancialRowRunLength = 0
    let maximumPlaceholderFinancialRowRunLength = 0
    for (const row of rawTabularRows) {
      const populatedCells = row.filter(Boolean)
      const isPlaceholderFinancialRow = populatedCells.length >= 7
        && /[a-z]/i.test(populatedCells[0]!)
        && populatedCells.slice(1).every(cell => /^(?:[–—-]|N\/?A)$/i.test(cell))
      placeholderFinancialRowRunLength = isPlaceholderFinancialRow
        ? placeholderFinancialRowRunLength + 1
        : 0
      maximumPlaceholderFinancialRowRunLength = Math.max(
        maximumPlaceholderFinancialRowRunLength,
        placeholderFinancialRowRunLength,
      )
    }
    const hasPlaceholderFinancialRecordRun = maximumRawColumnCount >= 7
      && maximumRawColumnCount <= 12
      && maximumPlaceholderFinancialRowRunLength >= 4
    const parallelNarrativeRowCount = rawTabularRows.filter(row =>
      row.filter(cell => (cell.match(/[a-z][a-z'-]*/gi) ?? []).length >= 4).length >= 2)
      .length
    const hasRepeatedParallelHeader = rawTabularRows.some((row) => {
      const labels = row
        .filter(cell => cell.length >= 4 && /[a-z]/i.test(cell))
        .map(cell => cell.toLowerCase())
      return labels.some((label, labelIndex) => labels.indexOf(label) !== labelIndex)
    })
    const hasDenseParallelFinancialTable = rawTabularRows.length >= 70
      && maximumRawColumnCount >= 5
      && maximumRawColumnCount <= 6
      && numericTableCellCount >= 70
      && directoryLabelCellCount >= 70
      && hasRepeatedParallelHeader
    const hasFragmentedParallelNarrative = rawTableRunCount >= 3
      && parallelNarrativeRowCount >= Math.max(6, Math.ceil(rawTabularRows.length * 0.2))
      && narrativeTableCellCount >= 15
      && narrativeTableCellCount >= numericTableCellCount * 0.75
    const hasSparseCompoundGrid = rawTableRunCount >= 4
      && rawTabularRows.length >= 10
      && maximumRawColumnCount >= 5
      && numericTableCellCount < rawTabularCells.length * 0.25
    const hasFragmentedDirectory = rawTableRunCount >= 8
      && maximumRawColumnCount <= 3
      && rawTabularCells.length >= 50
      && numericTableCellCount === 0
      && narrativeTableCellCount >= 15
    const locatedTabularCells = locateTableCells(rawTabularRows, pageItems)
    const stableColumnAnchors = stableTableColumnAnchors(
      locatedTabularCells,
      rawTabularRows.length,
      medianPageFontSize,
    )
    const widestColumnGap = stableColumnAnchors.slice(1)
      .map((rightAnchor, gapIndex) => ({
        gap: rightAnchor - stableColumnAnchors[gapIndex]!,
        splitAt: (rightAnchor + stableColumnAnchors[gapIndex]!) / 2,
      }))
      .sort((left, right) => right.gap - left.gap)[0]
    const leftColumnCount = widestColumnGap === undefined
      ? 0
      : stableColumnAnchors.filter(anchor => anchor < widestColumnGap.splitAt).length
    const rightColumnCount = stableColumnAnchors.length - leftColumnCount
    const leftTableCells = widestColumnGap === undefined
      ? []
      : locatedTabularCells.filter(cell => cell.x < widestColumnGap.splitAt)
    const rightTableCells = widestColumnGap === undefined
      ? []
      : locatedTabularCells.filter(cell => cell.x >= widestColumnGap.splitAt)
    const rightNarrativeCellCount = rightTableCells.filter(cell =>
      /[a-z]/i.test(cell.value) && !/^\(?[\d,.]+%?\)?$/.test(cell.value)).length
    const hasDetachedNarrativeSidebar = rawTabularRows.length >= 4
      && maximumRawColumnCount >= 5
      && widestColumnGap !== undefined
      && widestColumnGap.gap >= Math.max(100, medianPageFontSize * 12)
      && leftColumnCount >= 3
      && rightColumnCount >= 1
      && rightColumnCount <= 2
      && rightTableCells.length >= 3
      && rightTableCells.length <= leftTableCells.length * 0.5
      && rightNarrativeCellCount >= Math.ceil(rightTableCells.length * 0.8)
    const needsPositionedText = hasFragmentedFinancialTable
      || hasFragmentedSchedule
      || hasDetachedTableLabels
      || hasDetachedExhibitIdentifiers
      || hasFragmentedSignatures
      || hasDetachedNarrativeSidebar
      || hasDenseParallelFinancialTable
      || hasPlaceholderFinancialRecordRun
      || hasFragmentedParallelNarrative
      || hasSparseCompoundGrid
      || hasFragmentedDirectory
    if (needsPositionedText) {
      return [
        ':::spatial',
        ...renderPositionedTextLines(pageItems, medianPageFontSize),
        ':::',
      ].join('\n')
    }
    if (hasDenseSpatialCharts) {
      const firstRow = lines[0]!.split('\t').map(value => value.trim()).filter(Boolean)
      const title = firstRow[0]
      const metadata = firstRow.slice(1)
      return [
        ...(title ? [`# ${title}`, ''] : []),
        ...(metadata.length > 0 ? [metadata.join(' '), ''] : []),
        ':::spatial',
        ...lines.slice(1),
        ':::',
      ].join('\n').trim()
    }
    const numericMatrixItems = pageItems.filter(item =>
      /^[+\-]?\$?\(?\d[\d,.]*\)?%?$/.test(item.str))
      .sort((left, right) => right.y - left.y)
    const numericMatrixBaselines: Array<{
      y: number
      items: typeof pageItems
    }> = []
    for (const item of numericMatrixItems) {
      const existingBaseline = numericMatrixBaselines.find(baseline =>
        Math.abs(baseline.y - item.y) <= item.fontSize * 0.3)
      if (existingBaseline) {
        existingBaseline.items.push(item)
      }
      else {
        numericMatrixBaselines.push({ y: item.y, items: [item] })
      }
    }
    const matrixWidthCounts = numericMatrixBaselines.reduce((counts, baseline) => {
      if (baseline.items.length >= 5 && baseline.items.length <= 12) {
        counts.set(baseline.items.length, (counts.get(baseline.items.length) ?? 0) + 1)
      }
      return counts
    }, new Map<number, number>())
    const matrixWidth = [...matrixWidthCounts]
      .sort((left, right) => right[1] - left[1])[0]?.[0]
    const consistentMatrixRows = matrixWidth === undefined
      ? []
      : numericMatrixBaselines
          .filter(baseline => baseline.items.length === matrixWidth)
          .sort((left, right) => right.y - left.y)
    const firstMatrixValueX = Math.min(
      Infinity,
      ...consistentMatrixRows.flatMap(row => row.items.map(item => item.x)),
    )
    const matrixDescriptionItems = pageItems.filter(item =>
      item.x >= firstMatrixValueX * 0.5
      && item.x < firstMatrixValueX
      && /[a-z]/i.test(item.str)
      && consistentMatrixRows.some(row =>
        Math.abs(row.y - item.y) <= item.fontSize * 2))
    const topMatrixBaseline = consistentMatrixRows[0]?.y
    const matrixHeaderItems = topMatrixBaseline === undefined
      ? []
      : pageItems
          .filter(item =>
            item.x > firstMatrixValueX
            && item.y > topMatrixBaseline + medianPageFontSize * 2
            && item.y < topMatrixBaseline + medianPageFontSize * 10
            && /[a-z]/i.test(item.str))
          .sort((left, right) => left.x - right.x)
    const hasPositionedMatrix = rawTableRunCount >= 4
      && lines.length <= 60
      && consistentMatrixRows.length >= 5
      && firstMatrixValueX > 250
      && matrixDescriptionItems.length >= consistentMatrixRows.length * 2
      && matrixHeaderItems.length === matrixWidth
    if (hasPositionedMatrix) {
      const structuredMatrixLines: string[] = []
      const firstRow = lines[0]!.split('\t').map(value => value.trim()).filter(Boolean)
      if (firstRow[0]) {
        structuredMatrixLines.push(`# ${firstRow[0]}`, '')
      }
      if (firstRow.length > 1) {
        structuredMatrixLines.push(firstRow.slice(1).join(' '), '')
      }
      if (lines[1]) {
        structuredMatrixLines.push(`## ${lines[1]}`, '')
      }
      if (lines[2]) {
        structuredMatrixLines.push(lines[2], '')
      }

      const escapeCell = (value: string) => value
        .replaceAll('\\', '\\\\')
        .replaceAll('|', '\\|')
      const renderMatrixRow = (values: string[]) =>
        `| ${values.map(escapeCell).join(' | ')} |`
      const matrixHeader = ['Category', 'Description', ...matrixHeaderItems.map(item => item.str)]
      structuredMatrixLines.push(
        renderMatrixRow(matrixHeader),
        renderMatrixRow(matrixHeader.map(() => '---')),
      )
      const matrixDescriptions: string[] = []
      for (const [matrixRowIndex, matrixRow] of consistentMatrixRows.entries()) {
        const precedingRow = consistentMatrixRows[matrixRowIndex - 1]
        const followingRow = consistentMatrixRows[matrixRowIndex + 1]
        const upperBoundary = precedingRow
          ? (precedingRow.y + matrixRow.y) / 2
          : matrixRow.y + medianPageFontSize * 2
        const lowerBoundary = followingRow
          ? (followingRow.y + matrixRow.y) / 2
          : matrixRow.y - medianPageFontSize * 2
        const category = pageItems
          .filter(item =>
            item.x < firstMatrixValueX * 0.5
            && item.y <= upperBoundary
            && item.y > lowerBoundary
            && item.str.length <= 30
            && /[a-z]/i.test(item.str))
          .sort((left, right) =>
            Math.abs(left.y - matrixRow.y) - Math.abs(right.y - matrixRow.y))[0]
          ?.str ?? ''
        const description = pageItems
          .filter(item =>
            item.x >= firstMatrixValueX * 0.5
            && item.x < firstMatrixValueX
            && item.y <= upperBoundary
            && item.y > lowerBoundary
            && /[a-z]/i.test(item.str))
          .sort((left, right) => right.y - left.y || left.x - right.x)
          .map(item => item.str)
          .join(' ')
        matrixDescriptions.push(description)
        const values = matrixRow.items
          .sort((left, right) => left.x - right.x)
          .map(item => item.str)
        structuredMatrixLines.push(renderMatrixRow([
          category || description,
          category ? description : '',
          ...values,
        ]))
      }

      const finalTabularLineIndex = lines.findLastIndex(line => line.includes('\t'))
      const finalDescription = matrixDescriptions.at(-1) ?? ''
      for (const trailingLine of lines.slice(finalTabularLineIndex + 1)) {
        if (trailingLine && !finalDescription.includes(trailingLine)) {
          structuredMatrixLines.push('', trailingLine)
        }
      }
      return structuredMatrixLines.join('\n').trim()
    }
    const inferredHeadingLines = new Set<number>()
    const firstTextLine = lines.findIndex(line => line.length > 0)
    const reportingPeriodIndex = lines.findIndex((line, lineIndex) =>
      lineIndex >= firstTextLine
      && lineIndex <= firstTextLine + 4
      && /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(line))
    const hasCoverHeading = firstTextLine >= 0
      && reportingPeriodIndex > firstTextLine
      && lines.slice(firstTextLine, reportingPeriodIndex).every(line =>
        line.length > 0 && line.length <= 80 && !line.includes('\t'))

    if (hasCoverHeading) {
      lines[firstTextLine] = `# ${lines[firstTextLine]}`
      inferredHeadingLines.add(firstTextLine)

      for (let lineIndex = firstTextLine + 1; lineIndex < reportingPeriodIndex; lineIndex++) {
        lines[lineIndex] = `## ${lines[lineIndex]}`
        inferredHeadingLines.add(lineIndex)
      }

      lines[reportingPeriodIndex] = `*${lines[reportingPeriodIndex]}*`

      for (let lineIndex = firstTextLine + 1; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!
        if (line.includes('\t')) {
          break
        }
        if (/^[-•*] /.test(line)) {
          lines[lineIndex] = `- ${line.slice(2)}`
          continue
        }

        const labeledText = /^([^:]{1,50}:)(\s+\S.*)$/.exec(line)
        if (labeledText) {
          const introducesList = /^[-•*] /.test(lines[lineIndex + 1] ?? '')
          if (introducesList) {
            lines[lineIndex] = `## ${labeledText[1]!.slice(0, -1)}\n\n${labeledText[2]!.trim()}`
            inferredHeadingLines.add(lineIndex)
            continue
          }

          const nextLineIsLabeled = /^[^:]{1,50}:\s+\S/.test(lines[lineIndex + 1] ?? '')
          const continuesLabeledList = lines[lineIndex - 1]?.startsWith('- **') ?? false
          const listPrefix = nextLineIsLabeled || continuesLabeledList ? '- ' : ''
          lines[lineIndex] = `${listPrefix}**${labeledText[1]}**${labeledText[2]}`
          continue
        }

        const nextLine = lines[lineIndex + 1] ?? ''
        const introducesList = /^[-•*] /.test(nextLine)
        const introducesLabeledFields = /^[^:]{1,50}:\s+\S/.test(nextLine)
        if (
          !line.startsWith('#')
          && line.length > 0
          && line.length <= 80
          && !/[.!?:;]$/.test(line)
          && (introducesList || introducesLabeledFields || nextLine.includes('\t'))
        ) {
          lines[lineIndex] = `## ${line}`
          inferredHeadingLines.add(lineIndex)
        }
      }
    }

    const structuredLines: string[] = []
    let pageHasHeading = inferredHeadingLines.size > 0
    let previousTableWasPreamble = false
    let previousTableBottomBaseline = Infinity
    let tableRunCount = 0
    let lineIndex = 0

    while (lineIndex < lines.length) {
      const line = lines[lineIndex]!
      if (!line.includes('\t')) {
        const nextLine = lines[lineIndex + 1] ?? ''
        const previousLine = lines[lineIndex - 1] ?? ''
        const metadataLine = /^(?:As of\b|Parameters?:|Period\b|Book\b|Sort On\b|Posted by:|Fiscal Period\b|Report Date:|\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i.test(line)
          || line.includes(' = ')
          || line.endsWith('#')
          || /\bAccount #\b/i.test(line)
          || /https?:\/\/|\S+@\S+/.test(line)
        const words = line.match(/[a-z][a-z'-]*/gi) ?? []
        const firstLetter = line.match(/[a-z]/i)?.[0]
        const lineFontSize = Math.max(...(fontSizesByText.get(line) ?? [0]))
        const lineIsVisuallyProminent = medianPageFontSize > 0
          && lineFontSize >= medianPageFontSize * 1.15
        const lineIsStronglyProminent = medianPageFontSize > 0
          && lineFontSize >= medianPageFontSize * 1.3
        const titleText = line.length >= 4
          && line.length <= 100
          && words.length > 0
          && words.length <= 12
          && firstLetter === firstLetter?.toUpperCase()
          && !metadataLine
          && !/^[-•*] /.test(line)
          && !/[.!?;]$/.test(line)
          && (!line.includes(':') || /^[A-Z0-9 &/()-]+:$/.test(line))
        const nextLineIsMetadata = /^(?:As of\b|Parameters?:|Period\b|Book\b|Sort On\b|Posted by:|Fiscal Period\b|Report Date:|\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i.test(nextLine)
          || nextLine.includes(' = ')
          || /\bAccount #\b/i.test(nextLine)
        const startsDocumentSection = (lineIndex === firstTextLine || /[.!?]$/.test(previousLine))
          && (/^\d+[.)]?\s/.test(nextLine) || /[.!?]$/.test(nextLine))
        const introducesTable = nextLine.includes('\t')
        const tableHasCaption = introducesTable
          && (lineIndex === firstTextLine || previousLine === '' || previousLine.includes('\t'))
        const namesTableSection = pageHasHeading
          && introducesTable
          && !metadataLine
          && fontSizesByText.has(line)
          && (words.length >= 2
            || (words.length === 1 && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)))
          && words.length <= 8
          && !/^(?:(?:Grand )?Total\b|\d+[.)]?\s)/i.test(line)
        const namesCodedTableSection = pageHasHeading
          && introducesTable
          && /^(?=.*[-.])[A-Z0-9][A-Z0-9.-]{1,20}$/.test(line)
        const followsSmallPreambleTable = !pageHasHeading
          && introducesTable
          && previousLine.includes('\t')
          && previousTableWasPreamble
        const inferHeading = !inferredHeadingLines.has(lineIndex)
          && !isPageFooterText(line)
          && (
            namesTableSection
            || namesCodedTableSection
            || (titleText && (
              (!pageHasHeading && lineIsVisuallyProminent)
              || (!pageHasHeading && startsDocumentSection)
              || (lineIsStronglyProminent && (tableHasCaption || nextLineIsMetadata || startsDocumentSection))
              || followsSmallPreambleTable
            ))
          )

        if (inferHeading) {
          lines[lineIndex] = `${pageHasHeading ? '##' : '#'} ${line}`
          inferredHeadingLines.add(lineIndex)
          pageHasHeading = true
        }

        const renderedLineValue = lines[lineIndex]!
        const isHeading = inferredHeadingLines.has(lineIndex)
        const renderedLine = !isHeading && /^#{1,6} /.test(renderedLineValue)
          ? `\\${renderedLineValue}`
          : renderedLineValue
        if (isHeading && structuredLines.length > 0 && structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(renderedLine)
        if (isHeading && lines[lineIndex + 1] !== '') {
          structuredLines.push('')
        }
        if (hasCoverHeading && /^\*.+\*$/.test(renderedLineValue)) {
          structuredLines.push('')
        }
        lineIndex++
        continue
      }

      const rows: string[][] = []
      while (lineIndex < lines.length && lines[lineIndex]!.includes('\t')) {
        rows.push(lines[lineIndex]!.split('\t').map(cell =>
          cell.trim().replaceAll('\\', '\\\\').replaceAll('|', '\\|')))
        lineIndex++
      }
      const detachedBulletEntries = rows.flatMap((row) => {
        const values = row.filter(Boolean)
        return values.length === 2 && /^[-•*]$/.test(values[0]!)
          ? [values[1]!]
          : []
      })
      if (rows.length >= 2 && detachedBulletEntries.length === rows.length) {
        structuredLines.push(
          ...detachedBulletEntries.flatMap(entry => [`- ${entry}`, '']),
        )
        continue
      }
      const populatedNarrativeCells = rows.flatMap((row, rowIndex) =>
        row.flatMap((cell, cellIndex) => cell ? [{ cell, cellIndex, rowIndex }] : []))
      const locatedNarrativeCells = locateTableCells(rows, pageItems)
      const narrativeColumnAnchors = stableTableColumnAnchors(
        locatedNarrativeCells,
        rows.length,
        medianPageFontSize,
      )
      const proseCellCount = populatedNarrativeCells.filter(({ cell }) =>
        (cell.match(/[a-z][a-z'-]*/gi) ?? []).length >= 4).length
      const numericNarrativeCellCount = populatedNarrativeCells.filter(({ cell }) =>
        /^(?:[$–—-]|\(?\d[\d,.]*%?\)?)$/.test(cell)).length
      const parallelProseRowCount = rows.filter(row =>
        row.filter(cell => (cell.match(/[a-z][a-z'-]*/gi) ?? []).length >= 4).length >= 2)
        .length
      const hasAlignedNarrativeColumns = rows.length >= 4
        && narrativeColumnAnchors.length >= 2
        && narrativeColumnAnchors.length <= 4
        && proseCellCount >= Math.max(6, rows.length)
        && numericNarrativeCellCount <= Math.max(1, Math.ceil(populatedNarrativeCells.length * 0.05))
        && parallelProseRowCount >= Math.max(3, Math.ceil(rows.length / 2))
        && locatedNarrativeCells.length >= Math.ceil(populatedNarrativeCells.length * 0.8)
      if (hasAlignedNarrativeColumns) {
        const locatedCellBySource = new Map(locatedNarrativeCells.map(cell => [
          `${cell.rowIndex}:${cell.cellIndex}`,
          cell,
        ]))
        const narrativeColumns = narrativeColumnAnchors.map(() => [] as string[])
        for (const [rowIndex, row] of rows.entries()) {
          const rowValues = narrativeColumnAnchors.map(() => [] as string[])
          for (const [cellIndex, cell] of row.entries()) {
            if (!cell) {
              continue
            }
            const locatedCell = locatedCellBySource.get(`${rowIndex}:${cellIndex}`)
            const nearestColumn = locatedCell === undefined
              ? undefined
              : narrativeColumnAnchors
                  .map((anchor, columnIndex) => ({
                    columnIndex,
                    distance: Math.abs(anchor - locatedCell.x),
                  }))
                  .sort((left, right) => left.distance - right.distance)
                  .at(0)
            const targetColumn = nearestColumn?.columnIndex
              ?? Math.min(cellIndex, narrativeColumnAnchors.length - 1)
            rowValues[targetColumn]!.push(cell.replace(/\\([\\|#])/g, '$1'))
          }
          for (const [columnIndex, values] of rowValues.entries()) {
            if (values.length > 0) {
              narrativeColumns[columnIndex]!.push(values.join(' '))
            }
          }
        }
        for (const narrativeColumn of narrativeColumns) {
          structuredLines.push(...narrativeColumn, '')
        }
        continue
      }
      const exactItemsForCell = (cell: string) => cell
        .split('<br>')
        .map(segment => segment.replace(/\\([\\|#])/g, '$1'))
        .flatMap(segment => pageItems.filter(item => item.str === segment))
      const rowAxisItems = rows
        .map(row => row.filter(Boolean).flatMap((cell) => {
          const matches = exactItemsForCell(cell)
          return matches.length === 1 ? matches : []
        }))
        .filter(items => items.length >= 2)
        .sort((left, right) => right.length - left.length)[0]
      const coordinateSpan = (
        items: typeof rowAxisItems,
        coordinate: 'x' | 'y',
      ) => items === undefined
        ? Infinity
        : Math.max(...items.map(item => item[coordinate]))
          - Math.min(...items.map(item => item[coordinate]))
      const rowAxis = coordinateSpan(rowAxisItems, 'x') < coordinateSpan(rowAxisItems, 'y')
        ? 'x'
        : 'y'
      const rowVisualPositions = (row: string[]) => {
        const matchesByCell = row
          .filter(Boolean)
          .flatMap(cell => cell.split('<br>'))
          .map(exactItemsForCell)
          .filter(items => items.length > 0)
          .sort((left, right) => left.length - right.length)
        const leastAmbiguousMatchCount = matchesByCell[0]?.length
        if (leastAmbiguousMatchCount === undefined) {
          return []
        }
        return matchesByCell
          .filter(items => items.length === leastAmbiguousMatchCount)
          .flat()
          .map(item => item[rowAxis])
      }
      const wrappedRowLayout = {
        maximumContinuationGap: medianPageFontSize * 1.2,
        visualPositions: rowVisualPositions,
      }
      const narrativePreamble = tableRunCount === 0
        && rows.length <= 2
        && rows.every(row => row.filter(Boolean).length <= 3)
        && rows.some(row => row.some(cell => cell.length > 80))
        && rows.every(row => row.filter(cell => /\d/.test(cell)).length < 2)
      if (narrativePreamble) {
        const finalRow = rows.at(-1)!
        const finalCellIndex = finalRow.findLastIndex(Boolean)
        const followingLine = lines[lineIndex] ?? ''
        if (
          finalCellIndex >= 0
          && followingLine.length > 0
          && !followingLine.includes('\t')
          && !/[.!?]$/.test(finalRow[finalCellIndex]!)
        ) {
          finalRow[finalCellIndex] = `${finalRow[finalCellIndex]} ${followingLine}`
          lineIndex++
        }
        for (const [rowIndex, row] of rows.entries()) {
          const values = row.filter(Boolean)
          const leadingMarker = /^(?:(?:\d+|[a-z])[.)]|[-•*])$/i.test(values[0] ?? '')
          const normalizedMarker = /^[-•*]$/.test(values[0] ?? '')
            ? '-'
            : values[0]?.replace(/\)$/, '.')
          const renderedValues = leadingMarker && values[1]
            ? [`${normalizedMarker} ${values[1]}`, ...values.slice(2)]
            : values
          const pairedNarrative = renderedValues.length >= 2
            && renderedValues.some(value => value.length > 80)
          for (const [valueIndex, value] of renderedValues.entries()) {
            const isPageTitle = rowIndex === 0
              && valueIndex === 0
              && !pageHasHeading
              && value.length <= 100
              && !/[.!?;]$/.test(value)
              && !/^\(?continued\)?$/i.test(value)
              && !/^\d+(?:\.\s|$)/.test(value)
              && !/^[-•*]\s/.test(value)
            const isNarrativeLabel = rowIndex > 0
              && valueIndex === 0
              && pairedNarrative
              && value.length <= 80
              && !/^[-•*]\s/.test(value)
            if (isPageTitle || isNarrativeLabel) {
              structuredLines.push(`${isPageTitle ? '#' : '##'} ${value}`, '')
              pageHasHeading = true
            }
            else {
              structuredLines.push(value, '')
            }
          }
        }
        continue
      }
      let trailingTableFurniture: string[] = []
      previousTableWasPreamble = rows.length <= 2
        && rows.every(row => row.every(cell =>
          cell.length === 0
          || !/\d/.test(cell)))
      tableRunCount++
      const isNumericCell = (cell: string) =>
        /^(?:-|[+\-]?\$?\(?\d[\d,]*(?:\.\d+)?%?\)?|\d+\/\d+|\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\s*\*?$/.test(cell)
      const precedingStandaloneLabel = [...structuredLines]
        .reverse()
        .find(structuredLine => structuredLine.length > 0)
      const selectedTableBaselines: number[] = []

      for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex]!
        const suffixes = row.flatMap(cell => cell.split(/\s+/).filter(Boolean))
        if (suffixes.length === 0 || suffixes.some(cell => !/^\d{1,2}$/.test(cell))) {
          continue
        }

        const precedingRow = rows[rowIndex - 1]!
        const unfinishedColumns = precedingRow.flatMap((cell, columnIndex) =>
          cell.endsWith('.') ? [columnIndex] : [])
        if (unfinishedColumns.length !== suffixes.length) {
          continue
        }

        for (const [suffixIndex, columnIndex] of unfinishedColumns.entries()) {
          precedingRow[columnIndex] = precedingRow[columnIndex]! + suffixes[suffixIndex]!
        }
        rows.splice(rowIndex, 1)
        rowIndex--
      }

      const rowBaseline = (row: string[]): number | undefined => {
        const values = [...new Set(row
          .filter(Boolean)
          .map(cell => cell.replace(/\\([\\|#])/g, '$1')))]
        const candidates = values.flatMap(value => itemsByText.get(value) ?? [])
        const followingCandidates = candidates.filter(candidate =>
          candidate.y < previousTableBottomBaseline - candidate.fontSize * 0.2)
        const candidatesInReadingOrder = followingCandidates.length > 0
          ? followingCandidates
          : candidates
        const baseline = candidatesInReadingOrder
          .map(candidate => ({
            baseline: candidate.y,
            exactCharacters: values.reduce((count, value) => count + Math.max(
              0,
              ...(itemsByText.get(value) ?? [])
                .filter(item => Math.abs(item.y - candidate.y) <= item.fontSize * 0.3)
                .map(item => item.str.length),
            ), 0),
            matchedValues: values.filter(value => (itemsByText.get(value) ?? []).some(item =>
              Math.abs(item.y - candidate.y) <= item.fontSize * 0.3))
              .length,
          }))
          .sort((left, right) =>
            right.matchedValues - left.matchedValues
            || right.exactCharacters - left.exactCharacters)[0]
          ?.baseline
        if (baseline !== undefined) {
          selectedTableBaselines.push(baseline)
        }
        return baseline
      }
      let separatedTablePreamble = false
      const firstLikelyRecordRowIndex = rows.findIndex((row) => {
        const populatedCells = row.filter(Boolean)
        const numericCells = populatedCells.filter(isNumericCell)
        return populatedCells.length >= 2
          && numericCells.length >= Math.max(3, Math.ceil(populatedCells.length / 3))
      })
      if (firstLikelyRecordRowIndex > 1) {
        const headerBaselines = rows.slice(0, firstLikelyRecordRowIndex)
          .map(row => rowBaseline(row))
        let headerStart = headerBaselines.slice(1)
          .map((baseline, index) => ({
            gap: baseline === undefined || headerBaselines[index] === undefined
              ? 0
              : Math.abs(baseline - headerBaselines[index]!),
            rowIndex: index + 1,
          }))
          .filter(candidate =>
            candidate.rowIndex >= 2
            && candidate.gap > medianPageFontSize * 1.8)
          .sort((left, right) => right.rowIndex - left.rowIndex)[0]
          ?.rowIndex ?? 0
        const firstRecordWidth = rows[firstLikelyRecordRowIndex]!.length
        const firstRecordPopulation = rows[firstLikelyRecordRowIndex]!.filter(Boolean).length
        const preambleContainsWideHeader = rows.slice(0, headerStart).some(row =>
          row.length >= firstRecordWidth * 0.75
          && row.filter(Boolean).length >= Math.max(4, Math.ceil(firstRecordPopulation / 2)))
        if (preambleContainsWideHeader) {
          headerStart = 0
        }
        const preambleRows = rows.splice(0, headerStart)
        separatedTablePreamble = preambleRows.length > 0
        for (const preambleRow of preambleRows) {
          const preamble = preambleRow.filter(Boolean).join(' ')
          if (!preamble) {
            continue
          }
          if (structuredLines.at(-1) !== '') {
            structuredLines.push('')
          }
          const isOnlyPreamble = preambleRows.length === 1 && !pageHasHeading
          structuredLines.push(isOnlyPreamble ? `# ${preamble}` : preamble, '')
          pageHasHeading ||= isOnlyPreamble
        }
      }
      const trailingRow = rows.at(-1)
      const precedingRow = rows.at(-2)
      if (trailingRow && precedingRow && trailingRow.filter(Boolean).length <= 2) {
        const trailingBaseline = rowBaseline(trailingRow)
        const precedingBaseline = rowBaseline(precedingRow)
        if (
          trailingBaseline !== undefined
          && precedingBaseline !== undefined
          && precedingBaseline - trailingBaseline > medianPageFontSize * 8
        ) {
          trailingTableFurniture = rows.pop()!.filter(Boolean)
        }
      }

      const firstRecordAfterPreamble = rows.findIndex((row) => {
        const populatedCells = row.filter(Boolean)
        const numericCells = populatedCells.filter(isNumericCell)
        return populatedCells.length >= 2
          && numericCells.length >= Math.max(3, Math.ceil(populatedCells.length / 3))
      })
      const recordsContainPackedColumns = firstRecordAfterPreamble >= 0
        && rows.slice(firstRecordAfterPreamble).some(row => row.some(cell =>
          /^(?:[+\-]?\$?\(?\d[\d,.]*\)?\s+)+[+\-]?\$?\(?\d[\d,.]*\)?$/.test(cell)))
      let closestHeaderRowIndex = Math.max(0, firstRecordAfterPreamble - 1)
      while (
        closestHeaderRowIndex > 0
        && rows[closestHeaderRowIndex]!.some(isNumericCell)
      ) {
        closestHeaderRowIndex--
      }
      const headerAnchorRowIndex = firstRecordAfterPreamble < 0
        ? rows.length - 1
        : separatedTablePreamble || recordsContainPackedColumns
          ? closestHeaderRowIndex
          : 0
      const leadingRow = rows[headerAnchorRowIndex]
      if (leadingRow) {
        const leadingRowBaseline = rowBaseline(leadingRow)
        const separatedCellPairs = (combinedLabel: string, referenceBaseline?: number) => {
          const possibleParts = pageItems.filter(item =>
            item.str.trim().length > 0
            && combinedLabel.includes(item.str)
            && (referenceBaseline === undefined
              || Math.abs(item.y - referenceBaseline) <= item.fontSize * 2))
          const directPairs = possibleParts.flatMap(left => possibleParts.flatMap((right) => {
            const sameLine = Math.abs(left.y - right.y)
              <= Math.max(left.fontSize, right.fontSize) * 0.4
            const gap = right.x - (left.x + left.width)
            return sameLine
              && gap >= Math.max(left.fontSize, right.fontSize) * 0.5
              && `${left.str} ${right.str}` === combinedLabel
              ? [{ left, right, gap }]
              : []
          }))
          const stackedLeftPairs = possibleParts.flatMap((right) => {
            const leftLabel = combinedLabel.slice(0, -right.str.length).trim()
            if (!leftLabel || `${leftLabel} ${right.str}` !== combinedLabel) {
              return []
            }
            const leftParts: typeof pageItems = []
            let remainingLabel = leftLabel
            while (remainingLabel) {
              const nextPart = possibleParts
                .filter(item =>
                  !leftParts.includes(item)
                  && item.x < right.x
                  && Math.abs(item.y - right.y)
                  <= Math.max(item.fontSize, right.fontSize) * 2
                  && (remainingLabel === item.str || remainingLabel.startsWith(`${item.str} `)))
                .sort((left, candidate) => candidate.str.length - left.str.length)[0]
              if (!nextPart) {
                return []
              }
              leftParts.push(nextPart)
              remainingLabel = remainingLabel.slice(nextPart.str.length).trimStart()
            }
            const leftX = Math.min(...leftParts.map(item => item.x))
            const leftRight = Math.max(...leftParts.map(item => item.x + item.width))
            const gap = right.x - leftRight
            if (gap < Math.max(...leftParts.map(item => item.fontSize), right.fontSize) * 0.5) {
              return []
            }
            const left = {
              ...leftParts[0]!,
              str: leftLabel,
              x: leftX,
              width: leftRight - leftX,
            }
            return [{ left, right, gap }]
          })
          return [...directPairs, ...stackedLeftPairs]
        }
        const separatedLabels = leadingRow.flatMap((cell, columnIndex) => {
          const combinedLabel = cell.replace(/\\([\\|#])/g, '$1')
          const separatedPair = separatedCellPairs(combinedLabel, leadingRowBaseline)
            .sort((left, right) => right.gap - left.gap)[0]
          return separatedPair ? [{ columnIndex, ...separatedPair }] : []
        })
        const leadingLabels = leadingRow
          .map(cell => cell.replace(/\\([\\|#])/g, '$1'))
          .filter(Boolean)
        const possibleHeaderItems = pageItems.filter(item =>
          item.str.trim().length > 0 && leadingLabels.includes(item.str))
        const inferredHeaderItem = possibleHeaderItems
          .map(candidate => ({
            candidate,
            alignedLabels: possibleHeaderItems.filter(item =>
              Math.abs(item.y - candidate.y)
              <= Math.max(item.fontSize, candidate.fontSize) * 0.2).length,
          }))
          .sort((left, right) =>
            right.alignedLabels - left.alignedLabels
            || right.candidate.y - left.candidate.y)[0]
          ?.candidate
        const headerBaseline = separatedLabels[0]?.left.y ?? inferredHeaderItem?.y
        const claimedHeaderItems = new Set<(typeof pageItems)[number]>()
        const headerColumns = headerBaseline === undefined
          ? []
          : leadingRow.flatMap((cell, columnIndex) => {
              const separatedLabel = separatedLabels.find(label => label.columnIndex === columnIndex)
              if (separatedLabel) {
                claimedHeaderItems.add(separatedLabel.left)
                claimedHeaderItems.add(separatedLabel.right)
                return [separatedLabel.left, separatedLabel.right]
              }

              const label = cell.replace(/\\([\\|#])/g, '$1')
              if (!label) {
                return []
              }
              const exactLabel = pageItems
                .filter(item =>
                  item.str === label
                  && !claimedHeaderItems.has(item)
                  && Math.abs(item.y - headerBaseline) <= item.fontSize * 0.2)
                .sort((left, right) => left.x - right.x)[0]
              if (exactLabel) {
                claimedHeaderItems.add(exactLabel)
              }
              return exactLabel ? [exactLabel] : []
            })
              .sort((left, right) => left.x - right.x)
        const targetColumnForItem = (positionedItem: (typeof pageItems)[number]) => {
          if (isNumericCell(positionedItem.str)) {
            const itemRight = positionedItem.x + positionedItem.width
            return headerColumns
              .map((headerColumn, targetColumn) => ({
                distance: Math.abs(headerColumn.x + headerColumn.width - itemRight),
                targetColumn,
              }))
              .sort((left, right) => left.distance - right.distance)[0]
              ?.targetColumn
          }

          const itemCenter = positionedItem.x + positionedItem.width / 2
          return headerColumns
            .map((headerColumn, targetColumn) => ({
              distance: Math.abs(headerColumn.x + headerColumn.width / 2 - itemCenter),
              targetColumn,
            }))
            .sort((left, right) => left.distance - right.distance)[0]
            ?.targetColumn
        }
        const sourceColumnCount = Math.max(...rows.map(row => row.length))
        const bodyItems = headerBaseline === undefined
          ? []
          : pageItems.filter(item =>
              item.str.trim().length > 0
              && item.y < headerBaseline - item.fontSize * 0.2)
        const sourceColumnTargets = Array.from(
          { length: sourceColumnCount },
          (_, columnIndex) => {
            const values = rows.slice(headerAnchorRowIndex + 1)
              .map(row => (row[columnIndex] ?? '').replace(/\\([\\|#])/g, '$1'))
              .filter(Boolean)
            const positions = values.flatMap((value) => {
              const exactMatches = bodyItems.filter(item => item.str === value)
              const matchingItems = exactMatches.length > 0
                ? exactMatches
                : bodyItems.filter(item =>
                    item.str.trim().length >= 3 && value.includes(item.str))
              return matchingItems.map(item => ({
                right: item.x + item.width,
                x: item.x,
              }))
            })
            if (positions.length === 0 || headerColumns.length === 0) {
              return undefined
            }

            const sortedX = positions.map(position => position.x).sort((left, right) => left - right)
            const sortedRight = positions.map(position => position.right).sort((left, right) => left - right)
            const medianX = sortedX[Math.floor(sortedX.length / 2)]!
            const medianRight = sortedRight[Math.floor(sortedRight.length / 2)]!
            const numericValues = values.filter(isNumericCell).length
            if (numericValues >= Math.ceil(values.length / 2)) {
              return headerColumns
                .map((headerColumn, targetColumn) => ({
                  distance: Math.abs(headerColumn.x + headerColumn.width - medianRight),
                  targetColumn,
                }))
                .sort((left, right) => left.distance - right.distance)[0]!
                .targetColumn
            }

            const targetColumn = headerColumns.findLastIndex(headerColumn =>
              headerColumn.x <= medianX + headerColumn.fontSize * 0.5)
            return targetColumn >= 0 ? targetColumn : 0
          },
        )
        const populatedSourceColumns = Array.from(
          { length: sourceColumnCount },
          (_, columnIndex) => columnIndex,
        ).filter(columnIndex => rows.slice(headerAnchorRowIndex + 1)
          .some(row => (row[columnIndex] ?? '').length > 0))
        const leadingRowIntroducesRecords = (rows[headerAnchorRowIndex + 1] ?? [])
          .filter(isNumericCell)
          .length >= 2
        const headerContainsUnrepresentedColumns
          = populatedSourceColumns.length < headerColumns.length
        const leadingRowFinancialTokenCount = leadingRow
          .flatMap(cell => cell.split(/\s+/).filter(Boolean))
          .filter(isNumericCell)
          .length
        const leadingRowLooksLikeFinancialRecord = leadingRow.some(cell => /[a-z]/i.test(cell))
          && leadingRowFinancialTokenCount >= 3
        const canRebuildColumns = (
          separatedLabels.length > 0
          || headerContainsUnrepresentedColumns
        )
        && leadingRowIntroducesRecords
        && !leadingRowLooksLikeFinancialRecord
        && headerColumns.length >= 2
        && populatedSourceColumns.every(columnIndex =>
          sourceColumnTargets[columnIndex] !== undefined)
        if (canRebuildColumns) {
          const rebuiltRows = rows.map((row, rowIndex) => {
            if (rowIndex === headerAnchorRowIndex) {
              return headerColumns.map(item => item.str
                .replaceAll('\\', '\\\\')
                .replaceAll('|', '\\|'))
            }
            const rebuiltRow = Array.from<string>({ length: headerColumns.length }).fill('')
            const claimedRowItems = new Set<(typeof pageItems)[number]>()
            for (const [sourceColumn, value] of row.entries()) {
              if (!value) {
                continue
              }
              const sourceValue = value.replace(/\\([\\|#])/g, '$1')
              const candidateItems = rowIndex < headerAnchorRowIndex ? pageItems : bodyItems
              const baseline = rowBaseline(row)
              const exactMatches = candidateItems.filter(item =>
                item.str === sourceValue
                && !claimedRowItems.has(item)
                && (baseline === undefined || Math.abs(item.y - baseline) <= item.fontSize * 0.3))
              const exactMatch = exactMatches.sort((left, right) => left.x - right.x)[0]
              if (exactMatch) {
                claimedRowItems.add(exactMatch)
                const targetColumn = targetColumnForItem(exactMatch)
                  ?? sourceColumnTargets[sourceColumn]
                const numericParts = sourceValue.split(/\s+/).filter(Boolean)
                const canSplitNumericParts = numericParts.length >= 2
                  && numericParts.some(part => /\d/.test(part))
                  && numericParts.every(isNumericCell)
                if (targetColumn !== undefined && canSplitNumericParts) {
                  const firstTargetColumn = Math.min(
                    targetColumn,
                    headerColumns.length - numericParts.length,
                  )
                  for (const [partIndex, part] of numericParts.entries()) {
                    rebuiltRow[firstTargetColumn + partIndex] = part
                  }
                  continue
                }
                if (targetColumn !== undefined) {
                  rebuiltRow[targetColumn] = rebuiltRow[targetColumn]
                    ? `${rebuiltRow[targetColumn]} ${value}`
                    : value
                }
                continue
              }
              const sourceParts = sourceValue.split(/\s+/).filter(Boolean)
              const componentMatches = candidateItems
                .filter(item =>
                  !claimedRowItems.has(item)
                  && (sourceParts.includes(item.str)
                    || (item.str.trim().length >= 3 && sourceValue.includes(item.str)))
                  && (baseline === undefined || Math.abs(item.y - baseline) <= item.fontSize * 0.3))
                .sort((left, right) => left.x - right.x)
                .slice(0, sourceParts.length)
              const componentTargets = new Map<number, string[]>()
              for (const component of componentMatches) {
                claimedRowItems.add(component)
                const targetColumn = targetColumnForItem(component)
                if (targetColumn === undefined) {
                  continue
                }
                const targetValues = componentTargets.get(targetColumn) ?? []
                if (!targetValues.includes(component.str)) {
                  targetValues.push(component.str)
                }
                componentTargets.set(targetColumn, targetValues)
              }
              if (componentTargets.size <= 1) {
                const targetColumn = componentTargets.keys().next().value
                  ?? sourceColumnTargets[sourceColumn]
                if (targetColumn === undefined) {
                  continue
                }
                rebuiltRow[targetColumn] = rebuiltRow[targetColumn]
                  ? `${rebuiltRow[targetColumn]} ${value}`
                  : value
                continue
              }
              for (const [targetColumn, targetValues] of componentTargets) {
                const targetValue = targetValues.join(' ')
                rebuiltRow[targetColumn] = rebuiltRow[targetColumn]
                  ? `${rebuiltRow[targetColumn]} ${targetValue}`
                  : targetValue
              }
            }
            return rebuiltRow
          })
          rows.splice(
            0,
            rows.length,
            ...rebuiltRows,
          )
          let continuationBaseline = rowBaseline(rows.at(-1)!)
          while (
            continuationBaseline !== undefined
            && lineIndex < lines.length
            && lines[lineIndex]!.length > 0
            && !lines[lineIndex]!.includes('\t')
          ) {
            const continuation = lines[lineIndex]!
            const continuationItem = bodyItems
              .filter(item =>
                item.str === continuation
                && item.y < continuationBaseline!)
              .sort((left, right) => right.y - left.y)[0]
            if (
              !continuationItem
              || continuationBaseline - continuationItem.y > continuationItem.fontSize * 1.8
              || continuationItem.fontSize > medianPageFontSize * 1.2
            ) {
              break
            }
            const targetColumn = targetColumnForItem(continuationItem)
            const lastRow = rows.at(-1)
            if (targetColumn === undefined || !lastRow) {
              break
            }
            const escapedContinuation = continuation
              .replaceAll('\\', '\\\\')
              .replaceAll('|', '\\|')
            lastRow[targetColumn] = lastRow[targetColumn]
              ? `${lastRow[targetColumn]}<br>${escapedContinuation}`
              : escapedContinuation
            continuationBaseline = continuationItem.y
            lineIndex++
          }

          const possibleSummary = lines[lineIndex]
          const summaryValues = possibleSummary?.includes('\t')
            ? possibleSummary.split('\t').map(value => value.trim()).filter(Boolean)
            : []
          if (/^(?:Grand )?Totals?\b/i.test(summaryValues[0] ?? '')) {
            const summaryRow = Array.from<string>({ length: headerColumns.length }).fill('')
            for (const value of summaryValues) {
              const sourceValue = value.replace(/\\([\\|#])/g, '$1')
              const summaryItem = pageItems
                .filter(item => item.str === sourceValue)
                .sort((left, right) => right.y - left.y)[0]
              const targetColumn = summaryItem && targetColumnForItem(summaryItem)
              if (targetColumn !== undefined) {
                summaryRow[targetColumn] = value
              }
            }
            if (summaryRow.filter(Boolean).length === summaryValues.length) {
              rows.push(summaryRow)
              lineIndex++
            }
          }
        }
        else {
          for (const separatedLabel of separatedLabels.sort((left, right) =>
            right.columnIndex - left.columnIndex)) {
            const valuePositions = rows.flatMap((row, rowIndex) => {
              if (rowIndex === headerAnchorRowIndex) {
                return []
              }
              const value = (row[separatedLabel.columnIndex] ?? '').replace(/\\([\\|#])/g, '$1')
              if (!value) {
                return []
              }
              return pageItems.filter(item => item.str === value).map(item => item.x)
            }).sort((left, right) => left - right)
            leadingRow.splice(
              separatedLabel.columnIndex,
              1,
              separatedLabel.left.str,
              separatedLabel.right.str,
            )
            for (const [rowIndex, row] of rows.entries()) {
              if (rowIndex === headerAnchorRowIndex) {
                continue
              }
              const value = row[separatedLabel.columnIndex] ?? ''
              const numericParts = value.split(/\s+/).filter(Boolean)
              if (
                numericParts.length === 2
                && numericParts.some(part => /\d/.test(part))
                && numericParts.every(isNumericCell)
              ) {
                row.splice(separatedLabel.columnIndex, 1, ...numericParts)
                continue
              }
              const separatedValue = separatedCellPairs(
                value.replace(/\\([\\|#])/g, '$1'),
                rowBaseline(row),
              )
                .sort((left, right) =>
                  Math.abs(left.left.x - separatedLabel.left.x)
                  + Math.abs(left.right.x - separatedLabel.right.x)
                  - Math.abs(right.left.x - separatedLabel.left.x)
                  - Math.abs(right.right.x - separatedLabel.right.x))[0]
              if (separatedValue) {
                row.splice(
                  separatedLabel.columnIndex,
                  1,
                  separatedValue.left.str,
                  separatedValue.right.str,
                )
                continue
              }
              const valuePosition = valuePositions[Math.floor(valuePositions.length / 2)]
              const valuesAlignWithRightLabel = valuePosition !== undefined
                && Math.abs(valuePosition - separatedLabel.right.x)
                < Math.abs(valuePosition - separatedLabel.left.x)
              row.splice(
                separatedLabel.columnIndex,
                1,
                ...(valuesAlignWithRightLabel ? ['', value] : [value, '']),
              )
            }
          }
        }
      }

      const availableSourceColumnCount = Math.max(...rows.map(row => row.length))
      for (const row of rows) {
        for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
          const value = row[columnIndex] ?? ''
          const numericParts = value.split(/\s+/).filter(Boolean)
          const followingCells = Array.from(
            { length: numericParts.length - 1 },
            (_, partIndex) => row[columnIndex + partIndex + 1] ?? '',
          )
          if (
            numericParts.length < 2
            || !numericParts.some(part => /\d/.test(part))
            || !numericParts.every(isNumericCell)
            || columnIndex + numericParts.length > availableSourceColumnCount
            || followingCells.some(Boolean)
          ) {
            continue
          }
          for (const [partIndex, part] of numericParts.entries()) {
            row[columnIndex + partIndex] = part
          }
          columnIndex += numericParts.length - 1
        }
      }

      const leadingCaptionCells = rows[0]?.flatMap((cell, columnIndex) =>
        cell.length > 0 ? [{ cell, columnIndex }] : []) ?? []
      const followingRowsLookLikeHeaders = rows.slice(1, 4)
        .filter(row => row.filter(cell => cell.length > 0).length >= 2)
        .length >= 2
      const nearbyRowContainsValues = rows.slice(1).some(row =>
        row.filter(isNumericCell).length >= 2)
      const leadingMetadataLabel = leadingCaptionCells[0]?.cell ?? ''
      const leadingMetadataPreamble = leadingCaptionCells.length <= 3
        && /^(?:As of|Parameters?|Period|Book|Sort On|Posted by|Fiscal Period|Report Date):?(?:\s|$)/i.test(leadingMetadataLabel)
        && followingRowsLookLikeHeaders
        && nearbyRowContainsValues
      const leadingCaptionText = leadingCaptionCells[0]?.cell
      const leadingCaptionFontSize = Math.max(
        ...(fontSizesByText.get(leadingCaptionText ?? '') ?? [0]),
      )
      const followingHeaderFontSizes = rows.slice(1, 4)
        .flatMap(row => row.flatMap(cell => fontSizesByText.get(cell) ?? []))
        .sort((left, right) => left - right)
      const medianFollowingHeaderFontSize
        = followingHeaderFontSizes[Math.floor(followingHeaderFontSizes.length / 2)] ?? 0
      const leadingCaptionFirstLetter = leadingCaptionText?.match(/[a-z]/i)?.[0]
      const leadingCaptionLooksLikeTitle = leadingCaptionFirstLetter
        === leadingCaptionFirstLetter?.toUpperCase()
        && ((leadingCaptionText?.match(/[a-z]+/gi)?.length ?? 0) >= 2
          || (medianFollowingHeaderFontSize > 0
            && leadingCaptionFontSize >= medianFollowingHeaderFontSize * 1.1))
      const leadingCaption = leadingCaptionCells.length === 1
        && leadingCaptionCells[0]!.columnIndex > 0
        && followingRowsLookLikeHeaders
        && nearbyRowContainsValues
        && leadingCaptionLooksLikeTitle
        ? leadingCaptionCells[0]!.cell
        : undefined
      if (leadingCaption) {
        rows.shift()
        if (pageHasHeading) {
          if (structuredLines.at(-1) !== '') {
            structuredLines.push('')
          }
          structuredLines.push(`## ${leadingCaption}`, '')
        }
        else {
          structuredLines.unshift(`# ${leadingCaption}`, '')
        }
        pageHasHeading = true
      }
      else if (leadingMetadataPreamble) {
        const preamble = rows.shift()!.filter(Boolean).join(' ')
        if (structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(preamble, '')
      }

      const firstRecordRowIndex = rows.findIndex((row) => {
        const populatedCells = row.filter(cell => cell.length > 0)
        const numericCells = populatedCells.filter(isNumericCell)
        return populatedCells.length >= 2
          && numericCells.length >= Math.max(3, Math.ceil(populatedCells.length / 3))
      })
      if (firstRecordRowIndex > 0) {
        let stackedHeaderStart = firstRecordRowIndex
        while (stackedHeaderStart > 0) {
          const candidate = rows[stackedHeaderStart - 1]!
          const populatedCells = candidate.filter(cell => cell.length > 0)
          if (populatedCells.length === 0 || populatedCells.some(isNumericCell)) {
            break
          }
          stackedHeaderStart--
        }

        if (firstRecordRowIndex - stackedHeaderStart >= 2 && stackedHeaderStart > 0) {
          const preambleRows = rows.splice(0, stackedHeaderStart)
          for (const preambleRow of preambleRows) {
            const preamble = preambleRow.filter(cell => cell.length > 0).join(' ')
            if (preamble.length === 0) {
              continue
            }
            if (structuredLines.at(-1) !== '') {
              structuredLines.push('')
            }
            structuredLines.push(preamble, '')
          }
        }
      }

      if (tableRunCount === 1 && !pageHasHeading) {
        const headingCandidates = rows.slice(0, 2).flatMap((row, rowIndex) => {
          const populatedCells = row.filter(cell => cell.length > 0)
          if (populatedCells.length > 3) {
            return []
          }

          return row.flatMap((cell, columnIndex) => {
            const words = cell.match(/[a-z][a-z'-]*/gi) ?? []
            if (
              cell.length < 4
              || cell.length > 100
              || cell.endsWith(':')
              || words.length === 0
              || words.length > 12
              || isPageFooterText(cell)
            ) {
              return []
            }
            if (/https?:\/\/|\S+@\S+/.test(cell)) {
              return []
            }

            const companionLooksLikeMetadata = row.some((otherCell, otherColumnIndex) =>
              otherColumnIndex !== columnIndex
              && /\bPage\s+\d|\bAs of\b|\bReport Date\b|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}|^[\d.-]+$/i.test(otherCell))
            const letters = cell.replaceAll(/[^a-z]/gi, '')
            const isUppercase = letters.length >= 5 && letters === letters.toUpperCase()
            const score = 1
              + (companionLooksLikeMetadata ? 4 : 0)
              + (isUppercase ? 1 : 0)
              + (/\d/.test(cell) ? 0 : 2)
              + (words.length >= 2 && words.length <= 8 ? 1 : 0)
              - (cell.length > 60 ? 2 : 0)
              - (cell.includes(',') ? 2 : 0)
            return score >= 6 ? [{ cell, columnIndex, rowIndex, score }] : []
          })
        })
        const heading = headingCandidates.sort((left, right) =>
          right.score - left.score || left.cell.length - right.cell.length)[0]
        if (heading) {
          if (structuredLines.at(-1) !== '') {
            structuredLines.push('')
          }
          structuredLines.push(`# ${heading.cell}`, '')
          rows[heading.rowIndex]![heading.columnIndex] = ''
          pageHasHeading = true
        }
      }

      const remainingCells = rows.flatMap(row => row.filter(cell => cell.length > 0))
      if (rows.length === 1 && remainingCells.length <= 2) {
        if (structuredLines.at(-1) !== '' && remainingCells.length > 0) {
          structuredLines.push('')
        }
        structuredLines.push(...remainingCells)
        if (lineIndex < lines.length && lines[lineIndex] !== '') {
          structuredLines.push('')
        }
        continue
      }

      const trailingPageFooters: string[] = []
      while (rows.length > 0) {
        const populatedCells = rows.at(-1)!.filter(Boolean)
        const reportPageFooter = populatedCells.length <= 3
          && populatedCells.some(cell => /^\d{1,4}$/.test(cell))
          && populatedCells.some(cell => /\b(?:annual|financial) report\b/i.test(cell))
        if (!reportPageFooter || !populatedCells.every(isPageFooterText)) {
          break
        }
        trailingPageFooters.unshift(populatedCells.join(' '))
        rows.pop()
      }
      if (rows.length === 0) {
        if (structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(...trailingPageFooters)
        continue
      }

      const sourceColumnCount = Math.max(...rows.map(row => row.length))
      const populatedColumnIndexes = Array.from(
        { length: sourceColumnCount },
        (_, columnIndex) => columnIndex,
      ).filter(columnIndex => rows.some(row => (row[columnIndex] ?? '').length > 0))
      if (populatedColumnIndexes.length < sourceColumnCount) {
        for (const [rowIndex, row] of rows.entries()) {
          rows[rowIndex] = populatedColumnIndexes.map(columnIndex => row[columnIndex] ?? '')
        }
      }

      const columnCount = Math.max(...rows.map(row => row.length))
      const headerRowCount = inferHeaderRowCount(rows, isNumericCell)
      const hasHeader = headerRowCount > 0
      const widestRow = rows.find(row => row.length === columnCount)!
      const emptyHeader = [...widestRow]
      emptyHeader.fill('')
      const header = hasHeader
        ? combineHeaderRows(rows.slice(0, headerRowCount), columnCount)
        : emptyHeader
      const bodyRows = hasHeader ? rows.slice(headerRowCount) : rows
      const body = stitchWrappedRows(bodyRows, columnCount, isNumericCell, header, wrappedRowLayout)
      const precedingHeaderLabel = precedingStandaloneLabel?.replace(/^#{1,6} /, '')
      const firstPopulatedBodyColumn = Array.from(
        { length: columnCount },
        (_, columnIndex) => columnIndex,
      ).find(columnIndex =>
        body.slice(0, 5).filter(row => (row[columnIndex] ?? '').length > 0).length >= 2)
      const alignedHeaderColumn = precedingHeaderLabel === undefined
        || /^# (?!#)/.test(precedingStandaloneLabel ?? '')
        ? undefined
        : pageItems
          .filter(item => item.str === precedingHeaderLabel)
          .flatMap(labelItem => header.flatMap((cell, columnIndex) =>
            cell.split('<br>').flatMap((segment) => {
              const sourceSegment = segment.replace(/\\([\\|#])/g, '$1')
              return pageItems
                .filter(item =>
                  item.str === sourceSegment
                  && item.y < labelItem.y
                  && labelItem.y - item.y <= labelItem.fontSize * 4
                  && Math.abs(item.x - labelItem.x) <= labelItem.fontSize * 2)
                .map(item => ({
                  columnIndex,
                  horizontalGap: Math.abs(item.x - labelItem.x),
                  verticalGap: labelItem.y - item.y,
                }))
            })))
          .sort((left, right) =>
            left.horizontalGap - right.horizontalGap
            || left.verticalGap - right.verticalGap)[0]
          ?.columnIndex
      const emptyHeaderColumn = firstPopulatedBodyColumn !== undefined
        && header[firstPopulatedBodyColumn] === ''
        ? firstPopulatedBodyColumn
        : undefined
      const headerColumnToComplete = alignedHeaderColumn ?? emptyHeaderColumn
      const headerFontSizes = header.flatMap(cell => cell.split('<br>').flatMap((segment) => {
        const sourceSegment = segment.replace(/\\([\\|#])/g, '$1')
        return pageItems.filter(item => item.str === sourceSegment).map(item => item.fontSize)
      })).sort((left, right) => left - right)
      const medianHeaderFontSize = headerFontSizes[Math.floor(headerFontSizes.length / 2)] ?? 0
      const precedingLabelFontSize = Math.max(
        ...pageItems
          .filter(item => item.str === precedingHeaderLabel)
          .map(item => item.fontSize),
        0,
      )
      const precedingLabelIsSectionHeading = alignedHeaderColumn !== undefined
        && medianHeaderFontSize > 0
        && precedingLabelFontSize >= medianHeaderFontSize * 1.1
      const precedingLabelCanCompleteHeader = hasHeader
        && headerColumnToComplete !== undefined
        && precedingHeaderLabel !== undefined
        && precedingHeaderLabel.length <= 40
        && !precedingLabelIsSectionHeading
        && !/[=]|[.!?:;]$|https?:\/\/|\S+@\S+|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(precedingHeaderLabel)
      if (
        precedingLabelCanCompleteHeader
        && headerColumnToComplete !== undefined
        && precedingHeaderLabel !== undefined
        && precedingStandaloneLabel !== undefined
      ) {
        header[headerColumnToComplete] = header[headerColumnToComplete]
          ? `${precedingHeaderLabel}<br>${header[headerColumnToComplete]}`
          : precedingHeaderLabel
        const precedingLabelIndex = structuredLines.lastIndexOf(precedingStandaloneLabel)
        structuredLines.splice(precedingLabelIndex, 1)
      }
      else if (
        precedingLabelIsSectionHeading
        && precedingStandaloneLabel !== undefined
        && precedingHeaderLabel !== undefined
      ) {
        const precedingLabelIndex = structuredLines.lastIndexOf(precedingStandaloneLabel)
        structuredLines[precedingLabelIndex] = `## ${precedingHeaderLabel}`
      }
      const spanningSections = hasHeader
        ? rows.flatMap((row, rowIndex) => {
            if (rowIndex === 0 || rowIndex === rows.length - 1 || columnCount < 4) {
              return []
            }
            const populatedCells = row.flatMap((cell, columnIndex) =>
              cell.length > 0 ? [{ cell, columnIndex }] : [])
            if (populatedCells.length !== 1) {
              return []
            }

            const populatedCell = populatedCells[0]!
            const relativeColumn = populatedCell.columnIndex / (columnCount - 1)
            const surroundingRowsAreTabular = [rows[rowIndex - 1]!, rows[rowIndex + 1]!]
              .every(surroundingRow => surroundingRow.filter(cell => cell.length > 0).length >= 2)
            const labelFontSize = Math.max(...(fontSizesByText.get(populatedCell.cell) ?? [0]))
            const tableFontSizes = rows.flatMap(tableRow => tableRow.flatMap((cell) => {
              if (cell.length === 0 || cell === populatedCell.cell) {
                return []
              }
              return fontSizesByText.get(cell) ?? []
            })).sort((left, right) => left - right)
            const medianTableFontSize = tableFontSizes[Math.floor(tableFontSizes.length / 2)] ?? 0
            const labelIsVisuallyProminent = medianTableFontSize > 0
              && labelFontSize >= medianTableFontSize * 1.1
            if (
              populatedCell.columnIndex === 0
              || isNumericCell(populatedCell.cell)
              || populatedCell.cell.startsWith('#')
              || populatedCell.cell.length > 100
              || !surroundingRowsAreTabular
              || !labelIsVisuallyProminent
              || relativeColumn < 0.25
              || relativeColumn > 0.75
            ) {
              return []
            }
            return [{ label: populatedCell.cell, rowIndex }]
          })
        : []
      if (spanningSections.length > 0) {
        const tableTitleIndex = structuredLines.length - 1
        const tableTitle = structuredLines[tableTitleIndex]
        if (
          tableTitle
          && !tableTitle.startsWith('#')
          && tableTitle.length <= 80
          && !/[.!?:;]$/.test(tableTitle)
        ) {
          structuredLines[tableTitleIndex] = `## ${tableTitle}`
        }
      }
      const renderRow = (row: string[]) =>
        `| ${Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? '').join(' | ')} |`
      const renderBodyRow = (row: string[]) => renderRow(emphasizeSummaryRow(row))

      const separator = [...widestRow]
      separator.fill('---')
      const appendTable = (tableBody: string[][]) => {
        if (structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(renderRow(header))
        structuredLines.push(renderRow(separator))
        structuredLines.push(...tableBody.map(renderBodyRow))
      }

      if (spanningSections.length === 0) {
        appendTable(body)
      }
      else {
        const firstSection = spanningSections[0]!
        const openingRows = rows.slice(headerRowCount, firstSection.rowIndex)
        if (openingRows.length > 0) {
          appendTable(openingRows)
        }

        for (const [sectionIndex, section] of spanningSections.entries()) {
          if (structuredLines.at(-1) !== '') {
            structuredLines.push('')
          }
          structuredLines.push(`### ${section.label}`)

          const nextSection = spanningSections[sectionIndex + 1]
          const sectionRows = stitchWrappedRows(rows.slice(
            section.rowIndex + 1,
            nextSection?.rowIndex ?? rows.length,
          ), columnCount, isNumericCell, header, wrappedRowLayout)
          if (sectionRows.length > 0) {
            appendTable(sectionRows)
          }
        }
      }
      if (trailingTableFurniture.length > 0) {
        if (structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(...trailingTableFurniture)
      }
      if (trailingPageFooters.length > 0) {
        if (structuredLines.at(-1) !== '') {
          structuredLines.push('')
        }
        structuredLines.push(...trailingPageFooters)
      }
      if (lineIndex < lines.length && lines[lineIndex] !== '') {
        structuredLines.push('')
      }
      if (selectedTableBaselines.length > 0) {
        previousTableBottomBaseline = Math.min(...selectedTableBaselines)
      }
    }

    return structuredLines.join('\n').trim()
  })

  inheritContinuationContext(structuredPages)
  const articles = structuredPages.map((page, pageIndex) =>
    renderPageArticle(
      page,
      pageIndex + 1,
      extractedItems.items[pageIndex] ?? [],
      pageImages?.[pageIndex],
    ))

  return {
    totalPages,
    html: mergePages
      ? renderHTMLDocument(articles.join('\n<hr class="page-break">\n'), 'PDF document')
      : articles.map((article, pageIndex) =>
          renderHTMLDocument(article, `PDF page ${pageIndex + 1}`)),
  }
}

interface TableRow {
  kind: 'row'
  cells: string[]
}

interface TableSectionRow {
  kind: 'section'
  label: string
}

interface TableBlock {
  kind: 'table'
  header: string[]
  body: Array<TableRow | TableSectionRow>
}

interface ParallelTablesBlock {
  kind: 'parallel-tables'
  sections: Array<{
    heading?: string
    table: TableBlock
    notes: string[]
  }>
}

type PageBlock
  = | { kind: 'heading', level: number, text: string }
    | { kind: 'ordered-list', entries: OrderedListEntry[] }
    | { kind: 'unordered-list', entries: string[] }
    | { kind: 'paragraph', lines: string[] }
    | { kind: 'blockquote', lines: string[] }
    | { kind: 'spatial', lines: string[] }
    | ParallelTablesBlock
    | TableBlock

interface OrderedListEntry {
  depth: number
  marker: 'decimal' | 'lower-alpha'
  ordinal: number
  text: string
}

interface LocatedTableCell {
  cellIndex: number
  rowIndex: number
  value: string
  x: number
  y: number
}

function locateTableCells(
  rows: string[][],
  positionedText: StructuredTextItem[],
): LocatedTableCell[] {
  const visibleText = positionedText.filter(textRun => textRun.str.trim().length > 0)
  return rows.flatMap((row, rowIndex) => {
    const candidatesByCell = row.map((cell) => {
      const value = cell.replace(/\\([\\|#])/g, '$1')
      if (!value) {
        return { value, candidates: [] }
      }
      const candidates = visibleText.filter(textRun =>
        textRun.str === value
        || value.startsWith(`${textRun.str} `))
      return { value, candidates }
    })
    const possibleBaselines = candidatesByCell.flatMap(({ candidates }) =>
      candidates.map(textRun => textRun.y))
    const baseline = possibleBaselines.map(candidateBaseline => ({
      candidateBaseline,
      exactCharacters: candidatesByCell.reduce((characterCount, { value, candidates }) => {
        const matchingText = candidates.filter(textRun =>
          Math.abs(textRun.y - candidateBaseline) <= Math.max(1, textRun.fontSize * 0.35))
        return characterCount + Math.max(
          0,
          ...matchingText.map(textRun => textRun.str === value ? value.length : 0),
        )
      }, 0),
      matchedCells: candidatesByCell.filter(({ candidates }) => candidates.some(textRun =>
        Math.abs(textRun.y - candidateBaseline) <= Math.max(1, textRun.fontSize * 0.35)))
        .length,
    })).sort((left, right) =>
      right.matchedCells - left.matchedCells
      || right.exactCharacters - left.exactCharacters)[0]?.candidateBaseline

    if (baseline === undefined) {
      return []
    }

    return candidatesByCell.flatMap(({ value, candidates }, cellIndex) => {
      const textRun = candidates
        .filter(candidate =>
          Math.abs(candidate.y - baseline) <= Math.max(1, candidate.fontSize * 0.35))
        .sort((left, right) => left.x - right.x || right.str.length - left.str.length)[0]
      return textRun
        ? [{ cellIndex, rowIndex, value, x: textRun.x, y: textRun.y }]
        : []
    })
  })
}

function stableTableColumnAnchors(
  locatedCells: LocatedTableCell[],
  rowCount: number,
  medianFontSize: number,
): number[] {
  const clusters: Array<{ cells: LocatedTableCell[], x: number }> = []
  for (const locatedCell of [...locatedCells].sort((left, right) => left.x - right.x)) {
    const cluster = clusters.find(candidate =>
      Math.abs(candidate.x - locatedCell.x) <= Math.max(2, medianFontSize * 2))
    if (cluster) {
      cluster.cells.push(locatedCell)
      cluster.x = cluster.cells.reduce((sum, cell) => sum + cell.x, 0) / cluster.cells.length
      continue
    }
    clusters.push({ cells: [locatedCell], x: locatedCell.x })
  }

  const minimumRows = Math.max(2, Math.ceil(rowCount * 0.15))
  return clusters
    .filter(cluster => new Set(cluster.cells.map(cell => cell.rowIndex)).size >= minimumRows)
    .map(cluster => cluster.x)
    .sort((left, right) => left - right)
}

function renderPositionedTextLines(
  positionedText: StructuredTextItem[],
  medianFontSize: number,
): string[] {
  const visibleText = positionedText
    .filter(text => text.str.trim().length > 0)
    .sort((left, right) => right.y - left.y || left.x - right.x)
  const characterWidths = visibleText
    .filter(text => text.width > 0)
    .map(text => text.width / [...text.str.trim()].length)
    .sort((left, right) => left - right)
  const medianCharacterWidth = characterWidths[Math.floor(characterWidths.length / 2)]
    ?? Math.max(1, medianFontSize * 0.5)
  const leftEdge = Math.min(...visibleText.map(text => text.x))
  const lines: Array<{ y: number, text: StructuredTextItem[] }> = []

  for (const text of visibleText) {
    const line = lines.find(candidate =>
      Math.abs(candidate.y - text.y) <= text.fontSize * 0.8)
    if (!line) {
      lines.push({ y: text.y, text: [text] })
      continue
    }
    const duplicate = line.text.some(candidate =>
      candidate.str === text.str
      && Math.abs(candidate.x - text.x) <= text.fontSize * 0.1
      && Math.abs(candidate.y - text.y) <= text.fontSize * 0.1)
    if (!duplicate) {
      line.text.push(text)
    }
  }

  return lines.map((line) => {
    let renderedLine = ''
    let renderedLength = 0
    for (const text of line.text.sort((left, right) => left.x - right.x)) {
      const value = text.str.trim()
      const targetColumn = Math.round((text.x - leftEdge) / medianCharacterWidth)
      const gap = Math.max(renderedLine.length === 0 ? 0 : 1, targetColumn - renderedLength)
      renderedLine += `${' '.repeat(gap)}${value}`
      renderedLength += gap + [...value].length
    }
    return renderedLine
  })
}

function renderPageArticle(
  page: string,
  pageNumber: number,
  positionedText: StructuredTextItem[],
  pageImage?: string,
): string {
  const blocks = repairJoinedTableCells(mergeTableSections(enrichTableHeaders(
    splitParallelTables(attachTrailingCellContinuations(parsePageBlocks(page))),
  ), positionedText), positionedText).filter((block) => {
    if (block.kind !== 'table' || block.header.some(Boolean) || block.body.length !== 1) {
      return true
    }
    const row = block.body[0]
    if (row?.kind !== 'row' || row.cells.length < 4) {
      return true
    }
    const populated = row.cells.filter(Boolean)
    return populated.length !== row.cells.length
      || populated.some(cell => cell !== populated[0] || cell.length !== 1)
  })
  const content = blocks.map(renderPageBlock).join('\n')
  const preservedLayout = pageImage
    ? `<figure class="pdf-page-render"><img alt="" src="${pageImage}"></figure>\n`
    : ''
  return `<article class="pdf-page" data-page-number="${pageNumber}">\n${preservedLayout}${content}\n</article>`
}

function repairJoinedTableCells(
  blocks: PageBlock[],
  positionedText: StructuredTextItem[],
): PageBlock[] {
  const positionedTextByValue = new Map<string, StructuredTextItem[]>()
  for (const item of positionedText) {
    const matchingItems = positionedTextByValue.get(item.str) ?? []
    matchingItems.push(item)
    positionedTextByValue.set(item.str, matchingItems)
  }
  const repairTable = (table: TableBlock): TableBlock => {
    const body = table.body.map(row => row.kind === 'row'
      ? { kind: 'row' as const, cells: [...row.cells] }
      : row)
    const bodyRows = body.filter((row): row is TableRow => row.kind === 'row')
    if (table.header.length < 2 || bodyRows.length === 0) {
      return { ...table, body }
    }

    let precedingBaseline = Infinity
    const baselines = new Map<TableRow, number>()
    for (const row of bodyRows) {
      const rowValues = row.cells.flatMap(cell => cell.split('<br>')).filter(Boolean)
      const candidates = rowValues.flatMap(value => positionedTextByValue.get(value) ?? [])
      const followingCandidates = candidates.filter(item =>
        item.y < precedingBaseline - item.fontSize * 0.2)
      const candidatesInReadingOrder = followingCandidates.length > 0
        ? followingCandidates
        : candidates
      const baseline = candidatesInReadingOrder
        .map(candidate => ({
          y: candidate.y,
          matches: rowValues.filter(value => (positionedTextByValue.get(value) ?? []).some(item =>
            Math.abs(item.y - candidate.y) <= item.fontSize * 0.3)).length,
        }))
        .sort((left, right) => right.matches - left.matches || right.y - left.y)[0]
        ?.y
      if (baseline !== undefined) {
        baselines.set(row, baseline)
        precedingBaseline = baseline
      }
    }
    const firstBodyBaseline = baselines.get(bodyRows[0]!)
    if (firstBodyBaseline === undefined) {
      return { ...table, body }
    }

    const headerAnchors = table.header.map((cell) => {
      const segments = cell.split('<br>').filter(Boolean)
      const candidates = segments.flatMap(segment => positionedTextByValue.get(segment) ?? [])
        .filter(item =>
          item.y > firstBodyBaseline
          && item.y - firstBodyBaseline <= item.fontSize * 10)
      const nearestBaseline = Math.min(
        Infinity,
        ...candidates.map(item => item.y - firstBodyBaseline),
      )
      const nearestItems = candidates.filter(item =>
        item.y - firstBodyBaseline <= nearestBaseline + item.fontSize * 2)
      if (nearestItems.length === 0) {
        return undefined
      }
      const centers = nearestItems
        .map(item => item.x + item.width / 2)
        .sort((left, right) => left - right)
      return centers[Math.floor(centers.length / 2)]
    })

    for (const row of bodyRows) {
      const baseline = baselines.get(row)
      if (baseline === undefined) {
        continue
      }
      const itemsOnBaseline = positionedText.filter(item =>
        Math.abs(item.y - baseline) <= item.fontSize * 0.3)
      for (let columnIndex = 0; columnIndex < row.cells.length - 1; columnIndex++) {
        const joinedValue = row.cells[columnIndex] ?? ''
        if (!joinedValue || joinedValue.includes('<br>') || row.cells[columnIndex + 1]) {
          continue
        }
        const leadingAnchor = headerAnchors[columnIndex]
        const trailingAnchor = headerAnchors[columnIndex + 1]
        if (leadingAnchor === undefined || trailingAnchor === undefined) {
          continue
        }
        const components = itemsOnBaseline
          .filter(item =>
            item.str.trim().length >= 2
            && joinedValue.includes(item.str))
          .sort((left, right) => left.x - right.x)
        if (components.length < 2 || components.map(item => item.str).join(' ') !== joinedValue) {
          continue
        }
        const leadingValues: string[] = []
        const trailingValues: string[] = []
        for (const component of components) {
          const center = component.x + component.width / 2
          const target = Math.abs(center - leadingAnchor) <= Math.abs(center - trailingAnchor)
            ? leadingValues
            : trailingValues
          target.push(component.str)
        }
        if (leadingValues.length === 0 || trailingValues.length === 0) {
          continue
        }
        row.cells[columnIndex] = leadingValues.join(' ')
        row.cells[columnIndex + 1] = trailingValues.join(' ')
      }
    }

    const finalHeaderIndex = table.header.length - 1
    const finalHeaderLines = table.header[finalHeaderIndex]!.split('<br>')
    const finalHeaderLine = finalHeaderLines.at(-1)!
    const firstRowBaseline = baselines.get(bodyRows[0]!)!
    const finalHeaderItems = positionedText.filter(item =>
      finalHeaderLine.includes(item.str)
      && item.y > firstRowBaseline)
    const separatedFinalHeaders = finalHeaderItems.flatMap(left => finalHeaderItems.flatMap((right) => {
      const sameHeaderBand = left.y > firstRowBaseline
        && right.y > firstRowBaseline
        && Math.abs(left.y - right.y) <= Math.max(left.fontSize, right.fontSize) * 0.4
      const gap = right.x - (left.x + left.width)
      return sameHeaderBand
        && gap >= Math.max(left.fontSize, right.fontSize) * 0.5
        && `${left.str} ${right.str}` === finalHeaderLine
        ? [{ left, right, gap }]
        : []
    })).sort((left, right) =>
      Math.abs(left.left.y - firstRowBaseline) - Math.abs(right.left.y - firstRowBaseline)
      || right.gap - left.gap)[0]
    if (!separatedFinalHeaders) {
      return { ...table, body }
    }

    const leadingHeader = [
      ...finalHeaderLines.slice(0, -1),
      separatedFinalHeaders.left.str,
    ].join('<br>')
    const header = [
      ...table.header.slice(0, finalHeaderIndex),
      leadingHeader,
      separatedFinalHeaders.right.str,
    ]
    for (const row of bodyRows) {
      const value = row.cells[finalHeaderIndex] ?? ''
      const numericParts = value.split(/\s+/).filter(Boolean)
      if (numericParts.length === 2 && numericParts.every(part => /^\(?-?\$?[\d,.]+\)?$/.test(part))) {
        row.cells.splice(finalHeaderIndex, 1, ...numericParts)
        continue
      }
      const baseline = baselines.get(row)
      const valueItem = baseline === undefined
        ? undefined
        : (positionedTextByValue.get(value) ?? []).find(item =>
            item.str === value
            && Math.abs(item.y - baseline) <= item.fontSize * 0.3)
      const alignsWithTrailingHeader = valueItem
        && Math.abs(valueItem.x + valueItem.width - (separatedFinalHeaders.right.x + separatedFinalHeaders.right.width))
        < Math.abs(valueItem.x + valueItem.width - (separatedFinalHeaders.left.x + separatedFinalHeaders.left.width))
      row.cells.splice(
        finalHeaderIndex,
        1,
        ...(alignsWithTrailingHeader ? ['', value] : [value, '']),
      )
    }
    return { ...table, header, body }
  }

  return blocks.map((block) => {
    if (block.kind === 'table') {
      return repairTable(block)
    }
    if (block.kind !== 'parallel-tables') {
      return block
    }
    return {
      ...block,
      sections: block.sections.map(section => ({
        ...section,
        table: repairTable(section.table),
      })),
    }
  })
}

function renderHTMLDocument(content: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
body { color: #1f2937; font-family: system-ui, sans-serif; line-height: 1.45; margin: 2rem; }
.pdf-page { margin: 0 auto 3rem; max-width: 100%; }
.pdf-page-render { margin: 0 0 2rem; max-width: 100%; }
.pdf-page-render img { display: block; height: auto; max-width: 100%; }
.page-break { border: 0; border-top: 2px solid #94a3b8; margin: 3rem 0; }
.report-metadata { background: #f8fafc; border: 1px solid #cbd5e1; margin: 1rem 0; padding: .75rem 1rem; }
.metadata-row { display: flex; flex-wrap: wrap; gap: .5rem 2rem; margin: .25rem 0; }
table { border-collapse: collapse; display: block; margin: 1rem 0; max-width: 100%; overflow-x: auto; width: max-content; }
th, td { border: 1px solid #cbd5e1; padding: .35rem .55rem; text-align: left; vertical-align: top; }
thead th { background: #e2e8f0; }
tbody th[scope="row"] { font-weight: 400; }
tr.section th { background: #dbeafe; }
tr.summary > * { background: #f1f5f9; font-weight: 700; }
tfoot { border-top: 2px solid #475569; }
.parallel-tables { align-items: start; display: grid; gap: 2rem; grid-template-columns: repeat(var(--parallel-count), minmax(0, 1fr)); overflow-x: auto; }
.parallel-tables table { width: 100%; }
.table-with-notes { align-items: start; display: grid; gap: 2rem; grid-template-columns: max-content minmax(12rem, 1fr); }
.table-with-notes aside { margin-top: 1rem; }
.spatial-content { margin: 1rem 0; max-width: 100%; overflow-x: auto; }
@media print { body { margin: 0; } .pdf-page { break-after: page; } .page-break { display: none; } }
</style>
</head>
<body>
${content}
</body>
</html>`
}

function parsePageBlocks(page: string): PageBlock[] {
  const lines = page.split('\n')
  const blocks: PageBlock[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!
    if (line.length === 0) {
      lineIndex++
      continue
    }

    const heading = /^(#{1,6}) (.+)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      lineIndex++
      continue
    }

    if (line === ':::spatial') {
      const spatialLines: string[] = []
      lineIndex++
      while (lineIndex < lines.length && lines[lineIndex] !== ':::') {
        spatialLines.push(lines[lineIndex]!)
        lineIndex++
      }
      if (lines[lineIndex] === ':::') {
        lineIndex++
      }
      blocks.push({ kind: 'spatial', lines: spatialLines })
      continue
    }

    const tableHeader = structuredTableCells(line)
    if (tableHeader && /^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1] ?? '')) {
      const body: TableRow[] = []
      lineIndex += 2
      while (lineIndex < lines.length) {
        const cells = structuredTableCells(lines[lineIndex]!)
        if (!cells) {
          break
        }
        body.push({ kind: 'row', cells })
        lineIndex++
      }
      blocks.push(normalizeTable({ kind: 'table', header: tableHeader, body }))
      continue
    }

    const orderedListStart = /^\s*(\d+|[a-z])\.\s+/i.exec(line)
    const orderedListStartNumber = Number(orderedListStart?.[1])
    const orderedListStartsWithCalendarYear = Number.isInteger(orderedListStartNumber)
      && orderedListStartNumber >= 1900
      && orderedListStartNumber <= 2100
    if (orderedListStart && !orderedListStartsWithCalendarYear) {
      const entries: OrderedListEntry[] = []
      while (lineIndex < lines.length) {
        const entryLine = lines[lineIndex]!
        const marker = /^(\s*)(\d+|[a-z])\. /i.exec(entryLine)
        const numericMarker = Number(marker?.[2])
        const markerIsCalendarYear = Number.isInteger(numericMarker)
          && numericMarker >= 1900
          && numericMarker <= 2100
        if (!marker || markerIsCalendarYear) {
          break
        }
        entries.push({
          depth: Math.floor(marker[1]!.length / 3),
          marker: /^\d+$/.test(marker[2]!) ? 'decimal' : 'lower-alpha',
          ordinal: /^\d+$/.test(marker[2]!)
            ? Number(marker[2])
            : marker[2]!.toLowerCase().charCodeAt(0) - 96,
          text: entryLine.slice(marker[0].length),
        })
        lineIndex++
      }
      blocks.push({ kind: 'ordered-list', entries })
      continue
    }

    if (line.startsWith('- ')) {
      const entries: string[] = []
      while (lineIndex < lines.length && lines[lineIndex]!.startsWith('- ')) {
        entries.push(lines[lineIndex]!.slice(2))
        lineIndex++
      }
      blocks.push({ kind: 'unordered-list', entries })
      continue
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (lineIndex < lines.length && lines[lineIndex]!.startsWith('> ')) {
        quoteLines.push(lines[lineIndex]!.slice(2))
        lineIndex++
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines })
      continue
    }

    const paragraphLines: string[] = []
    while (lineIndex < lines.length && lines[lineIndex]!.length > 0) {
      const candidate = lines[lineIndex]!
      const candidateOrderedList = /^\s*(\d+|[a-z])\.\s+/i.exec(candidate)
      const candidateOrderedListNumber = Number(candidateOrderedList?.[1])
      const candidateStartsWithCalendarYear = Number.isInteger(candidateOrderedListNumber)
        && candidateOrderedListNumber >= 1900
        && candidateOrderedListNumber <= 2100
      if (
        /^(?:#{1,6}|- |> )/.test(candidate)
        || (candidateOrderedList && !candidateStartsWithCalendarYear)
        || (structuredTableCells(candidate)
          && /^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1] ?? ''))
      ) {
        break
      }
      paragraphLines.push(candidate)
      lineIndex++
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraphLines })
      continue
    }
    lineIndex++
  }

  return blocks
}

function mergeTableSections(
  blocks: PageBlock[],
  positionedText: StructuredTextItem[],
): PageBlock[] {
  const merged: PageBlock[] = []

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!
    if (block.kind !== 'table') {
      merged.push(block)
      continue
    }

    const table: TableBlock = {
      kind: 'table',
      header: block.header,
      body: [...block.body],
    }
    let followingIndex = blockIndex + 1
    while (followingIndex + 1 < blocks.length) {
      const bridgedLabels: string[] = []
      let continuationIndex = followingIndex
      while (continuationIndex < blocks.length) {
        const candidate = blocks[continuationIndex]!
        if (candidate.kind === 'paragraph') {
          if (candidate.lines.some(line =>
            line.length > 80
            || /[.!?]$|https?:\/\/|\S+@\S+/.test(line))) {
            break
          }
          bridgedLabels.push(...candidate.lines)
          continuationIndex++
          continue
        }
        if (candidate.kind === 'heading' && candidate.level >= 2 && candidate.text.length <= 80) {
          bridgedLabels.push(candidate.text)
          continuationIndex++
          continue
        }
        break
      }
      const bridgedContinuation = blocks[continuationIndex]
      const bridgedContinuationHasRows = bridgedContinuation?.kind === 'table'
        && bridgedContinuation.body.some(row => row.kind === 'row')
      const bridgesMultipleLabels = bridgedLabels.length > 1
        && bridgedContinuation?.kind === 'table'
        && bridgedContinuationHasRows
      const label = blocks[followingIndex]!
      const continuation = bridgesMultipleLabels
        ? bridgedContinuation!
        : blocks[followingIndex + 1]!
      const compactSectionHeading = !bridgesMultipleLabels
        && label.kind === 'heading'
        && label.level >= 2
        && label.text.length <= 20
        && /^[a-z0-9]+(?:[-.][a-z0-9]+)*:?$/i.test(label.text)
      const continuationRows = continuation.kind === 'table'
        ? continuation.body.filter((row): row is TableRow => row.kind === 'row')
        : []
      const headerlessSectionContinuation = compactSectionHeading
        && continuation.kind === 'table'
        && continuation.header.every(cell => cell.length === 0)
        && continuationRows.length > 0
        && continuationRows.every(row => row.cells.length <= table.header.length - 1)
      if (headerlessSectionContinuation && label.kind === 'heading') {
        const alignedRows = continuationRows.map(row => ({
          kind: 'row' as const,
          cells: [
            '',
            ...row.cells,
            ...Array.from<string>({
              length: table.header.length - row.cells.length - 1,
            }).fill(''),
          ],
        }))
        table.body.push({ kind: 'section', label: label.text }, ...alignedRows)
        followingIndex += 2
        continue
      }
      const sparseRowLabels = bridgesMultipleLabels
        ? bridgedLabels
        : label.kind === 'paragraph'
          && label.lines.length > 1
          && label.lines.every(line =>
            line.length <= 80
            && !/[.!?]$|https?:\/\/|\S+@\S+/.test(line))
          ? label.lines
          : undefined
      const sectionLabel = bridgesMultipleLabels
        ? undefined
        : label.kind === 'heading' && label.level === 3
          ? label.text
          : label.kind === 'paragraph' && label.lines.length === 1
            ? label.lines[0]
            : undefined
      const tableHasHeader = table.header.some(cell => cell.length > 0)
      const continuationHasHeader = continuation.kind === 'table'
        && continuation.header.some(cell => cell.length > 0)
      if (
        (!sectionLabel && !sparseRowLabels)
        || (sectionLabel?.length ?? 0) > 80
        || continuation.kind !== 'table'
        || continuationRows.length === 0
        || (bridgesMultipleLabels && !tableHasHeader && continuationHasHeader)
        || (!bridgesMultipleLabels
          && !tableHasHeader
          && continuationHasHeader
          && table.header.length !== continuation.header.length)
        || !tableSchemasAreCompatible(table.header, continuation.header)
      ) {
        break
      }
      let mergedHeader = table.header
      let mergedBody = table.body
      const needsLeadingHeaderColumn = table.body.length === 0
        && tableHasHeader
        && !continuationHasHeader
        && continuation.header.length === table.header.length + 1
      if (needsLeadingHeaderColumn) {
        const alignedDetachedHeader = alignHeaderToContinuation(
          table.header,
          continuation,
          positionedText,
        )
        if (!alignedDetachedHeader || alignedDetachedHeader[0]) {
          break
        }
        mergedHeader = alignedDetachedHeader
      }
      const detachedHeaderRows = table.body.flatMap(row => row.kind === 'row' ? [row.cells] : [])
      const detachedRowsAreHeaderLike = !tableHasHeader
        && detachedHeaderRows.length === table.body.length
        && detachedHeaderRows.length >= 1
        && detachedHeaderRows.length <= 4
        && detachedHeaderRows.every(row =>
          row.filter(Boolean).length >= 2
          && row.every(cell =>
            parseFinancialValue(cell) === undefined
            || /^(?:19|20)\d{2}$/.test(cell)))
      const alignedDetachedHeader = detachedRowsAreHeaderLike
        ? alignHeaderToContinuation(
            combineHeaderRows(
              detachedHeaderRows,
              Math.max(...detachedHeaderRows.map(row => row.length)),
            ),
            continuation,
            positionedText,
          )
        : undefined
      const detachedHeader = alignedDetachedHeader !== undefined
        && (!alignedDetachedHeader[0]
          || (detachedHeaderRows.length === 1 && continuationHasHeader))
        && (continuationHasHeader
          || continuationRows.some(row =>
            row.cells.filter(cell => parseFinancialValue(cell) !== undefined).length >= 2))
      if (!tableHasHeader && continuationHasHeader && !detachedHeader) {
        break
      }
      let rowsToAlign = continuation.body
      if (detachedHeader) {
        mergedHeader = alignedDetachedHeader
        mergedBody = []
        if (
          continuationHasHeader
          && !headersAreEqual(mergedHeader, continuation.header)
        ) {
          rowsToAlign = [
            { kind: 'row', cells: continuation.header },
            ...rowsToAlign,
          ]
        }
      }
      let hasUnsafeOverwideRow = false
      const alignedRows = rowsToAlign.map((row) => {
        if (row.kind !== 'row') {
          return row
        }
        if (row.cells.length > mergedHeader.length) {
          const leadingCellCount = row.cells.length - mergedHeader.length + 1
          const leadingCells = row.cells.slice(0, leadingCellCount).filter(Boolean)
          const trailingCells = row.cells.slice(leadingCellCount).filter(Boolean)
          const joinedLeadingCells = leadingCells.join(' ')
          const leadingCellsAreText = leadingCells.every(cell =>
            parseFinancialValue(cell) === undefined)
          const leadingCellsAreDate = /^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(joinedLeadingCells)
          const trailingCellsAreFinancial = trailingCells.length > 0
            && trailingCells.every(cell => parseFinancialValue(cell) !== undefined)
          if ((!leadingCellsAreText && !leadingCellsAreDate) || !trailingCellsAreFinancial) {
            hasUnsafeOverwideRow = true
            return row
          }
          return {
            kind: 'row' as const,
            cells: [
              joinedLeadingCells,
              ...row.cells.slice(leadingCellCount),
            ],
          }
        }
        if (row.cells.length === mergedHeader.length) {
          return row
        }
        return {
          kind: 'row' as const,
          cells: [
            ...Array.from<string>({ length: mergedHeader.length - row.cells.length }).fill(''),
            ...row.cells,
          ],
        }
      })
      if (hasUnsafeOverwideRow) {
        break
      }
      table.header = mergedHeader
      table.body = mergedBody
      if (sparseRowLabels) {
        table.body.push(
          ...sparseRowLabels.map(labelText => ({
            kind: 'row' as const,
            cells: [
              labelText,
              ...Array.from<string>({ length: table.header.length - 1 }).fill(''),
            ],
          })),
          ...alignedRows,
        )
        followingIndex = bridgesMultipleLabels ? continuationIndex + 1 : followingIndex + 2
        continue
      }
      if (!sectionLabel) {
        break
      }
      const precedingRow = table.body.at(-1)
      const detailRows = alignedRows.filter((row): row is TableRow => row.kind === 'row')
      const nextFirstColumnValue = detailRows.findIndex(row => (row.cells[0] ?? '').length > 0)
      const leadingDetailRows = nextFirstColumnValue === -1
        ? detailRows
        : detailRows.slice(0, nextFirstColumnValue)
      const continuesFirstColumn = precedingRow?.kind === 'row'
        && (precedingRow.cells[0] ?? '').length > 0
        && precedingRow.cells.filter(cell => parseFinancialValue(cell) !== undefined).length >= 2
        && leadingDetailRows.length >= 2
        && leadingDetailRows.some(row => (row.cells[1] ?? '').length > 0)
      if (continuesFirstColumn && precedingRow?.kind === 'row') {
        table.body[table.body.length - 1] = {
          kind: 'row',
          cells: [
            `${precedingRow.cells[0]}<br>${sectionLabel}`,
            ...precedingRow.cells.slice(1),
          ],
        }
        table.body.push(...alignedRows)
      }
      else {
        table.body.push({ kind: 'section', label: sectionLabel }, ...alignedRows)
      }
      followingIndex += 2
    }
    const precedingLabel = merged.at(-1)
    const precedingLabels = precedingLabel?.kind === 'paragraph'
      ? precedingLabel.lines.flatMap(line => line.split('<br>')).filter(Boolean)
      : []
    const tableRows = table.body.filter((row): row is TableRow => row.kind === 'row')
    const numericColumns = table.header.flatMap((_, columnIndex) => {
      const numericValues = tableRows.filter(row =>
        parseFinancialValue(row.cells[columnIndex] ?? '') !== undefined)
      return numericValues.length >= 2 ? [columnIndex] : []
    })
    let numericSuffixStart = table.header.length
    while (numericColumns.includes(numericSuffixStart - 1)) {
      numericSuffixStart--
    }
    const detachedHeadersFitNumericSuffix = table.header.every(cell => cell.length === 0)
      && precedingLabels.length > 0
      && precedingLabels.length <= table.header.length - numericSuffixStart
      && precedingLabels.every(label => label.length <= 40 && !/[.!?:;]$/.test(label))
    if (detachedHeadersFitNumericSuffix) {
      table.header = table.header.map((_, columnIndex) =>
        precedingLabels[columnIndex - numericSuffixStart] ?? '')
      merged.pop()
    }
    merged.push(table)
    blockIndex = followingIndex - 1
  }

  return merged
}

function attachTrailingCellContinuations(blocks: PageBlock[]): PageBlock[] {
  const attached: PageBlock[] = []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!
    const continuation = blocks[blockIndex + 1]
    if (
      block.kind !== 'table'
      || continuation?.kind !== 'paragraph'
      || continuation.lines.length !== 1
      || !/^[a-z][a-z' -]{0,79}$/i.test(continuation.lines[0]!)
    ) {
      attached.push(block)
      continue
    }
    const table: TableBlock = {
      ...block,
      body: block.body.map(row => row.kind === 'row'
        ? { kind: 'row', cells: [...row.cells] }
        : row),
    }
    const lastRow = [...table.body].reverse().find(row => row.kind === 'row')
    if (lastRow?.kind !== 'row') {
      attached.push(block)
      continue
    }
    const candidateColumns = lastRow.cells.flatMap((cell, columnIndex) =>
      cell.endsWith(',') ? [columnIndex] : [])
    const continuationColumn = candidateColumns.find(columnIndex =>
      table.body.some(row =>
        row.kind === 'row' && (row.cells[columnIndex] ?? '').includes('<br>')))
    if (continuationColumn === undefined) {
      attached.push(block)
      continue
    }
    lastRow.cells[continuationColumn]
      = `${lastRow.cells[continuationColumn]}<br>${continuation.lines[0]}`
    attached.push(table)
    blockIndex++
  }
  return attached
}

function splitParallelTables(blocks: PageBlock[]): PageBlock[] {
  const separated: PageBlock[] = []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!
    if (block.kind !== 'table') {
      separated.push(block)
      continue
    }
    const normalizedLabels = block.header.map(label =>
      label.toLowerCase().replaceAll(/\s+/g, ''))
    const repeatedGroupWidth = Array.from(
      { length: Math.floor(block.header.length / 2) - 1 },
      (_, index) => index + 2,
    ).find(groupWidth =>
      block.header.length % groupWidth === 0
      && block.header.length / groupWidth <= 4
      && block.header.slice(0, groupWidth).every(Boolean)
      && normalizedLabels.every((label, columnIndex) =>
        label === normalizedLabels[columnIndex % groupWidth]))
    const repeatedGroupCount = repeatedGroupWidth === undefined
      ? 0
      : block.header.length / repeatedGroupWidth
    const repeatedSections = repeatedGroupWidth === undefined
      ? []
      : Array.from({ length: repeatedGroupCount }, (_, groupIndex) => {
          const start = groupIndex * repeatedGroupWidth
          const end = start + repeatedGroupWidth
          const body = block.body.flatMap((row) => {
            if (row.kind !== 'row') {
              return []
            }
            const cells = row.cells.slice(start, end)
            return cells.some(Boolean)
              ? [{ kind: 'row' as const, cells: removeInapplicableSummaryEmphasis(cells) }]
              : []
          })
          return {
            table: {
              kind: 'table' as const,
              header: block.header.slice(start, end),
              body,
            },
            notes: [],
          }
        })
    const repeatedGroupsAreTables = repeatedSections.length >= 2
      && block.body.every(row => row.kind === 'row')
      && repeatedSections.every(section => section.table.body.length >= 1)
    if (repeatedGroupsAreTables) {
      separated.push({ kind: 'parallel-tables', sections: repeatedSections })
      continue
    }

    const labels = block.header.map(cell => cell.split('<br>').at(-1) ?? '')
    const statusColumns = labels.flatMap((label, columnIndex) =>
      label === 'Status' ? [columnIndex] : [])
    if (statusColumns.length !== 2 || statusColumns[0] !== 0) {
      separated.push(block)
      continue
    }
    const boundary = statusColumns[1]!
    const leftHeadingColumn = headingOnlyColumn(block, 0, boundary)
    const rightHeadingColumn = headingOnlyColumn(block, boundary, block.header.length)
    let leftHeading = tableHeading(block.header.slice(0, boundary))
      ?? (leftHeadingColumn === undefined ? undefined : block.header[leftHeadingColumn])
    let rightHeading = tableHeading(block.header.slice(boundary))
      ?? (rightHeadingColumn === undefined ? undefined : block.header[rightHeadingColumn])
    const precedingHeadings = separated.at(-1)
    if (
      (!leftHeading || !rightHeading)
      && precedingHeadings?.kind === 'paragraph'
      && precedingHeadings.lines.length === 2
    ) {
      leftHeading = precedingHeadings.lines[0]
      rightHeading = precedingHeadings.lines[1]
      separated.pop()
    }
    if (!leftHeading || !rightHeading) {
      separated.push(block)
      continue
    }

    const leftBody: Array<TableRow | TableSectionRow> = []
    const rightBody: Array<TableRow | TableSectionRow> = []
    const rightNotes: string[] = []
    const rightColumnCount = block.header.length - boundary
    for (const row of block.body) {
      if (row.kind === 'section') {
        continue
      }
      if (row.cells.length >= block.header.length) {
        const populatedCellCount = row.cells.filter(Boolean).length
        const firstValue = row.cells.find(Boolean)?.replaceAll('**', '')
        const repeatsLeftLabel = firstValue !== undefined && leftBody.some(leftRow =>
          leftRow.kind === 'row'
          && leftRow.cells.find(Boolean)?.replaceAll('**', '') === firstValue)
        const shiftedRightRow = repeatsLeftLabel
          && populatedCellCount === rightColumnCount
          && row.cells.slice(rightColumnCount).every(cell => cell.length === 0)
        if (shiftedRightRow) {
          rightBody.push({ kind: 'row', cells: row.cells.slice(0, rightColumnCount) })
          continue
        }

        const leftCells = row.cells.slice(0, boundary)
        if (leftCells.some(Boolean)) {
          leftBody.push({ kind: 'row', cells: leftCells })
        }
        const rightCells = row.cells.slice(boundary)
        const firstRightValue = rightCells.find(Boolean)?.replaceAll('**', '')
        if (firstRightValue?.startsWith('* ')) {
          rightNotes.push(...rightCells.filter(Boolean))
        }
        else if (rightCells.some(Boolean)) {
          rightBody.push({
            kind: 'row',
            cells: removeInapplicableSummaryEmphasis(rightCells),
          })
        }
        continue
      }
      if (row.cells.length === rightColumnCount) {
        rightBody.push({ kind: 'row', cells: row.cells })
        continue
      }
      leftBody.push({ kind: 'row', cells: row.cells.slice(0, boundary) })
      rightNotes.push(...row.cells.slice(boundary).filter(Boolean))
    }

    let consumedBlocks = 0
    const noteContinuation = blocks[blockIndex + 1]
    const leftContinuation = blocks[blockIndex + 2]
    if (
      rightNotes.length > 0
      && noteContinuation?.kind === 'paragraph'
      && leftContinuation?.kind === 'table'
      && leftContinuation.header.length === boundary
      && leftContinuation.header.every(cell => cell.length === 0)
    ) {
      rightNotes[rightNotes.length - 1]
        = `${rightNotes.at(-1)} ${noteContinuation.lines.join(' ')}`
      leftBody.push(...leftContinuation.body)
      consumedBlocks = 2
    }

    separated.push({
      kind: 'parallel-tables',
      sections: [
        {
          heading: leftHeading,
          table: {
            kind: 'table',
            header: labels.slice(0, boundary)
              .filter((_, columnIndex) => columnIndex !== leftHeadingColumn),
            body: removeTableColumn(leftBody, leftHeadingColumn),
          },
          notes: [],
        },
        {
          heading: rightHeading,
          table: {
            kind: 'table',
            header: labels.slice(boundary)
              .filter((_, columnIndex) =>
                rightHeadingColumn === undefined
                || columnIndex !== rightHeadingColumn - boundary),
            body: removeTableColumn(
              rightBody,
              rightHeadingColumn === undefined ? undefined : rightHeadingColumn - boundary,
            ),
          },
          notes: rightNotes,
        },
      ],
    })
    blockIndex += consumedBlocks
  }
  return separated
}

function headingOnlyColumn(
  table: TableBlock,
  start: number,
  end: number,
): number | undefined {
  return Array.from({ length: end - start }, (_, index) => start + index)
    .find((columnIndex) => {
      const label = table.header[columnIndex] ?? ''
      return (label.match(/[a-z]+/gi)?.length ?? 0) >= 2
        && table.body.every(row => row.kind !== 'row' || !(row.cells[columnIndex] ?? ''))
    })
}

function removeTableColumn(
  rows: Array<TableRow | TableSectionRow>,
  columnIndex: number | undefined,
): Array<TableRow | TableSectionRow> {
  if (columnIndex === undefined) {
    return rows
  }
  return rows.map(row => row.kind === 'section'
    ? row
    : {
        kind: 'row',
        cells: row.cells.filter((_, index) => index !== columnIndex),
      })
}

function tableHeading(header: string[]): string | undefined {
  return header.flatMap((cell) => {
    const segments = cell.split('<br>')
    return segments.length > 1 ? [segments.slice(0, -1).join(' ')] : []
  }).sort((left, right) => right.length - left.length)[0]
}

function removeInapplicableSummaryEmphasis(cells: string[]): string[] {
  const firstValue = cells.find(Boolean)?.replaceAll('**', '')
  if (firstValue && /^(?:Grand )?Total\b/i.test(firstValue)) {
    return cells
  }
  return cells.map(cell => /^\*\*.*\*\*$/.test(cell) ? cell.slice(2, -2) : cell)
}

function enrichTableHeaders(blocks: PageBlock[]): PageBlock[] {
  const enriched: PageBlock[] = []
  for (const block of blocks) {
    if (block.kind !== 'table') {
      enriched.push(block)
      continue
    }
    const table = { ...block, header: [...block.header] }
    const precedingLabel = enriched.at(-1)
    if (precedingLabel?.kind === 'paragraph') {
      const labels = precedingLabel.lines.join(' ').match(/(?:Avg|Average|Net)\s+[A-Za-z]+/g) ?? []
      const unlabeledColumns = table.header.flatMap((cell, columnIndex) =>
        cell.startsWith('Application<br>') ? [columnIndex] : [])
      if (labels.length > 0 && labels.length === unlabeledColumns.length) {
        for (const [labelIndex, columnIndex] of unlabeledColumns.entries()) {
          table.header[columnIndex] = `${labels[labelIndex]}<br>${table.header[columnIndex]}`
        }
        enriched.pop()
      }
    }
    const groupLabel = enriched.at(-1)
    if (groupLabel?.kind === 'paragraph') {
      const paragraphLabels = groupLabel.lines.flatMap(line => line.split('<br>'))
      const columnGroups = inferAnchoredColumnGroups(table.header).map(group => group.label)
      if (
        paragraphLabels.length > 0
        && paragraphLabels.length === columnGroups.length
        && paragraphLabels.every((label, labelIndex) => label === columnGroups[labelIndex])
      ) {
        enriched.pop()
      }
    }
    enriched.push(table)
  }
  return enriched
}

function headersAreEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((cell, index) => cell === right[index])
}

function tableSchemasAreCompatible(left: string[], right: string[]): boolean {
  if (Math.abs(left.length - right.length) > 1) {
    return false
  }
  const populatedLeft = left.some(cell => cell.length > 0)
  const populatedRight = right.some(cell => cell.length > 0)
  return !populatedLeft
    || !populatedRight
    || headersAreEqual(left, right)
}

function alignHeaderToContinuation(
  header: string[],
  continuation: TableBlock,
  positionedText: StructuredTextItem[],
): string[] | undefined {
  const continuationRows = [
    continuation.header,
    ...continuation.body.flatMap(row => row.kind === 'row' ? [row.cells] : []),
  ]
  const locatedContinuationCells = locateTableCells(continuationRows, positionedText)
  const continuationColumnAnchors = Array.from({ length: continuation.header.length }, (_, columnIndex) => {
    const positions = locatedContinuationCells
      .filter(cell => cell.cellIndex === columnIndex)
      .map(cell => cell.x)
      .sort((left, right) => left - right)
    return positions[Math.floor(positions.length / 2)]
  })
  const topContinuationBaseline = Math.max(...locatedContinuationCells.map(cell => cell.y))
  if (!Number.isFinite(topContinuationBaseline)) {
    return undefined
  }

  const claimedTextRuns = new Set<StructuredTextItem>()
  const locatedHeaderSegments: Array<{
    fontSize: number
    label: string
    x: number
    y: number
  }> = []
  const headerSegments = header.flatMap(cell => cell.split('<br>').filter(Boolean))
  for (const label of headerSegments) {
    const sourceLabel = label.replaceAll('**', '').replace(/\\([\\|#])/g, '$1')
    const textRun = positionedText
      .filter(candidate =>
        candidate.str === sourceLabel
        && !claimedTextRuns.has(candidate)
        && candidate.y > topContinuationBaseline
        && candidate.y - topContinuationBaseline <= Math.max(1, candidate.fontSize) * 12)
      .sort((left, right) =>
        left.y - right.y
        || left.x - right.x)[0]
    if (!textRun) {
      return undefined
    }
    claimedTextRuns.add(textRun)
    locatedHeaderSegments.push({
      fontSize: textRun.fontSize,
      label,
      x: textRun.x,
      y: textRun.y,
    })
  }

  const headerBaselines: Array<typeof locatedHeaderSegments> = []
  for (const segment of [...locatedHeaderSegments].sort((left, right) => right.y - left.y)) {
    const baseline = headerBaselines.find(candidate =>
      Math.abs(candidate[0]!.y - segment.y)
      <= Math.max(candidate[0]!.fontSize, segment.fontSize) * 0.35)
    if (baseline) {
      baseline.push(segment)
    }
    else {
      headerBaselines.push([segment])
    }
  }
  const anchorBaseline = headerBaselines.sort((left, right) =>
    right.length - left.length
    || left[0]!.y - right[0]!.y)[0]
  if (!anchorBaseline) {
    return undefined
  }
  const sortedAnchors = anchorBaseline
    .map(segment => segment.x)
    .sort((left, right) => left - right)
  const missingLeadingColumn = sortedAnchors.length === continuation.header.length - 1
  if (sortedAnchors.length !== continuation.header.length && !missingLeadingColumn) {
    return undefined
  }
  if (missingLeadingColumn) {
    const firstContinuationColumn = continuationColumnAnchors[0]
    const secondContinuationColumn = continuationColumnAnchors[1]
    if (
      firstContinuationColumn === undefined
      || secondContinuationColumn === undefined
      || Math.abs(sortedAnchors[0]! - secondContinuationColumn)
      >= Math.abs(sortedAnchors[0]! - firstContinuationColumn)
    ) {
      return undefined
    }
  }

  const firstHeaderColumn = missingLeadingColumn ? 1 : 0
  const alignedSegments: Array<Array<{ label: string, x: number, y: number }>>
    = continuation.header.map(() => [])
  for (const segment of locatedHeaderSegments) {
    const targetColumn = sortedAnchors
      .map((anchor, columnOffset) => ({
        columnIndex: firstHeaderColumn + columnOffset,
        distance: Math.abs(anchor - segment.x),
      }))
      .sort((left, right) => left.distance - right.distance)[0]!
      .columnIndex
    alignedSegments[targetColumn]!.push(segment)
  }
  return alignedSegments.map(segments => segments
    .sort((left, right) => right.y - left.y || left.x - right.x)
    .map(segment => segment.label)
    .filter((label, labelIndex, labels) => labels.indexOf(label) === labelIndex)
    .join('<br>'))
}

function normalizeTable(table: TableBlock): TableBlock {
  const promoted = promoteLeadingHeaderRows(table)
  const calendar = expandCalendarColumns(promoted)
  const aligned = alignColumnGroupSummaries(calendar)
  const packedFinancialValue = /^(\(?-?\$?\d[\d,]*\.\d{2}\)?)\s+(\S.*)$/
  const packedTrailingColumn = aligned.header.flatMap((cell, columnIndex) => {
    const labels = cell.split(/\s+/).filter(Boolean)
    const precedingColumnIsEmpty = columnIndex > 0 && !aligned.header[columnIndex - 1]
    const followingColumnIsEmpty = columnIndex < aligned.header.length - 1
      && !aligned.header[columnIndex + 1]
    if (labels.length !== 2 || (!precedingColumnIsEmpty && !followingColumnIsEmpty)) {
      return []
    }
    const leadingColumn = precedingColumnIsEmpty ? columnIndex - 1 : columnIndex
    const trailingColumn = leadingColumn + 1
    const matchingRows = aligned.body.filter(row =>
      row.kind === 'row'
      && [row.cells[leadingColumn], row.cells[trailingColumn]]
        .some(value => packedFinancialValue.test(value ?? '')))
    return matchingRows.length >= 2
      ? [{ leadingColumn, leadingLabel: labels[0]!, trailingColumn, trailingLabel: labels[1]! }]
      : []
  })[0] ?? aligned.header.slice(0, -1).flatMap((leadingLabel, leadingColumn) => {
    const trailingColumn = leadingColumn + 1
    const trailingLabel = aligned.header[trailingColumn]!
    if (!leadingLabel || !trailingLabel) {
      return []
    }
    const rows = aligned.body.filter((row): row is TableRow => row.kind === 'row')
    const packedRows = rows.filter((row) => {
      const packedValue = packedFinancialValue.exec(row.cells[leadingColumn] ?? '')
      return packedValue !== null
        && /[a-z]/i.test(packedValue[2]!)
    })
    const financialRows = rows.filter(row =>
      parseFinancialValue(row.cells[leadingColumn] ?? '') !== undefined
      || packedFinancialValue.test(row.cells[leadingColumn] ?? ''))
    return packedRows.length > 0
      && financialRows.length >= 2
      ? [{ leadingColumn, leadingLabel, trailingColumn, trailingLabel }]
      : []
  })[0]
  const normalized = packedTrailingColumn
    ? {
        ...aligned,
        header: aligned.header.map((cell, columnIndex) => {
          if (columnIndex === packedTrailingColumn.leadingColumn) {
            return packedTrailingColumn.leadingLabel
          }
          if (columnIndex === packedTrailingColumn.trailingColumn) {
            return packedTrailingColumn.trailingLabel
          }
          return cell
        }),
        body: aligned.body.map((row) => {
          if (row.kind !== 'row') {
            return row
          }
          const packedColumn = [packedTrailingColumn.leadingColumn, packedTrailingColumn.trailingColumn]
            .find(columnIndex => packedFinancialValue.test(row.cells[columnIndex] ?? ''))
          if (packedColumn === undefined) {
            return row
          }
          const packedValue = packedFinancialValue.exec(row.cells[packedColumn]!)!
          const existingRemark = packedColumn === packedTrailingColumn.leadingColumn
            ? row.cells[packedTrailingColumn.trailingColumn] ?? ''
            : ''
          const cells = [...row.cells]
          cells[packedTrailingColumn.leadingColumn] = packedValue[1]!
          cells[packedTrailingColumn.trailingColumn]
            = [packedValue[2]!, existingRemark].filter(Boolean).join(' ')
          return { kind: 'row' as const, cells }
        }),
      }
    : aligned
  const lastColumn = normalized.header.length - 1
  const precedingColumn = lastColumn - 1
  const rows = normalized.body.filter((row): row is TableRow => row.kind === 'row')
  const lastColumnNumericCount = rows.filter(row =>
    parseFinancialValue(row.cells[lastColumn] ?? '') !== undefined).length
  const precedingColumnTextCount = rows.filter((row) => {
    const value = row.cells[precedingColumn] ?? ''
    return value.length > 0 && parseFinancialValue(value) === undefined
  }).length
  if (lastColumnNumericCount < 2 || precedingColumnTextCount < 2) {
    return normalized
  }
  return {
    ...normalized,
    body: normalized.body.map((row) => {
      if (row.kind !== 'row' || row.cells[lastColumn]) {
        return row
      }
      const misplacedValue = parseFinancialValue(row.cells[precedingColumn] ?? '')
      if (misplacedValue === undefined) {
        return row
      }
      const cells = [...row.cells]
      cells[lastColumn] = cells[precedingColumn]!
      cells[precedingColumn] = ''
      return { kind: 'row', cells }
    }),
  }
}

function alignColumnGroupSummaries(table: TableBlock): TableBlock {
  const groups = inferAnchoredColumnGroups(table.header)
  if (groups.length === 0) {
    return table
  }
  const body = table.body.map((row) => {
    if (row.kind === 'section') {
      return row
    }
    const populated = row.cells.filter(Boolean)
    const summaries = populated.flatMap((cell) => {
      const value = cell.replaceAll('**', '')
      const group = groups.find(candidate =>
        value.toLowerCase().startsWith(`total ${candidate.label.toLowerCase()}:`))
      return group ? [{ cell, group }] : []
    })
    if (summaries.length === 0 || summaries.length !== populated.length) {
      return row
    }
    const cells = Array.from<string>({ length: table.header.length }).fill('')
    for (const summary of summaries) {
      cells[summary.group.start] = summary.cell
    }
    return { kind: 'row' as const, cells }
  })
  return { ...table, body }
}

function promoteLeadingHeaderRows(table: TableBlock): TableBlock {
  if (table.header.some(cell => cell.length > 0)) {
    return table
  }
  const rows = table.body.flatMap(row => row.kind === 'row' ? [row.cells] : [])
  const firstRecordRow = rows.findIndex((row) => {
    const populated = row.filter(Boolean)
    const numeric = populated.filter(isStructuredNumericCell)
    return populated.length >= 3 && numeric.length >= Math.ceil(populated.length / 3)
  })
  const hasColumnGroupLabel = rows.some((row) => {
    const labels = row.filter(Boolean)
    return new Set(labels).size < labels.length
  })
  const headerRowCount = firstRecordRow === -1
    && rows.length >= 2
    && rows.length <= 4
    && hasColumnGroupLabel
    && rows.every(row => row.filter(Boolean).length >= 2 && row.every(cell => !isStructuredNumericCell(cell)))
    ? rows.length
    : firstRecordRow
  if (headerRowCount <= 0 || headerRowCount > 4) {
    return table
  }
  const headerRows = rows.slice(0, headerRowCount)
  if (headerRows.some(row => row.filter(Boolean).length < 2 || row.some(isStructuredNumericCell))) {
    return table
  }
  const columnCount = Math.max(table.header.length, ...headerRows.map(row => row.length))
  const header = Array.from({ length: columnCount }, (_, columnIndex) =>
    headerRows.map(row => row[columnIndex] ?? '').filter(Boolean).join('<br>'))
  return {
    kind: 'table',
    header,
    body: table.body.slice(headerRowCount),
  }
}

function expandCalendarColumns(table: TableBlock): TableBlock {
  if (table.header[0] !== 'Month') {
    return table
  }
  const calendarLabel = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|YTD)$/
  const spans = table.header.map((cell) => {
    const labels = cell.split(/\s+/)
    return labels.length > 1 && labels.every(label => calendarLabel.test(label)) ? labels : [cell]
  })
  if (spans.every(labels => labels.length === 1)) {
    return table
  }

  const body: Array<TableRow | TableSectionRow> = []
  for (const row of table.body) {
    if (row.kind === 'section') {
      body.push(row)
      continue
    }
    const cells: string[] = []
    let embeddedSection: string | undefined
    let overflowValues: string[] = []
    for (const [columnIndex, labels] of spans.entries()) {
      const [value, section] = (row.cells[columnIndex] ?? '').split('<br>', 2)
      embeddedSection ??= section
      if (labels.length === 1) {
        cells.push(overflowValues.shift() ?? value ?? '')
        continue
      }
      const values = [
        ...overflowValues,
        ...(value?.split(/\s+/).filter(Boolean) ?? []),
      ]
      overflowValues = values.slice(labels.length)
      const visibleValues = values.slice(0, labels.length)
      const leadingEmptyCells = labels.at(-1) === 'YTD' && overflowValues.length === 0
        ? labels.length - visibleValues.length
        : 0
      cells.push(...Array.from({ length: labels.length }, (_, valueIndex) =>
        visibleValues[valueIndex - leadingEmptyCells] ?? ''))
    }
    body.push({ kind: 'row', cells })
    if (embeddedSection) {
      body.push({ kind: 'section', label: embeddedSection })
    }
  }
  return {
    kind: 'table',
    header: spans.flat(),
    body,
  }
}

function isStructuredNumericCell(cell: string): boolean {
  const value = cell.replaceAll('**', '')
  return /^(?:(?:-|[+\-]?\$?\(?\d[\d,]*(?:\.\d+)?%?\)?|\d+\/\d+|\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\s*\*?|#DIV\/0!)$/.test(value)
}

function renderPageBlock(block: PageBlock): string {
  if (block.kind === 'heading') {
    return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`
  }
  if (block.kind === 'unordered-list') {
    return `<ul>\n${block.entries.map(entry => `<li>${renderInline(entry)}</li>`).join('\n')}\n</ul>`
  }
  if (block.kind === 'ordered-list') {
    return renderOrderedList(block.entries)
  }
  if (block.kind === 'blockquote') {
    return `<blockquote>\n${block.lines.map(line => `<p>${renderInline(line)}</p>`).join('\n')}\n</blockquote>`
  }
  if (block.kind === 'paragraph') {
    return `<p>${block.lines.map(renderInline).join('<br>')}</p>`
  }
  if (block.kind === 'spatial') {
    return `<figure class="spatial-content"><pre>${escapeHTML(block.lines.join('\n'))}</pre></figure>`
  }
  if (block.kind === 'parallel-tables') {
    const sections = block.sections.map(section =>
      `<section>${section.heading ? `\n<h3>${renderInline(section.heading)}</h3>` : ''}\n${renderTable(section.table)}${section.notes.map(note => `\n<p>${renderInline(note)}</p>`).join('')}\n</section>`)
    return `<div class="parallel-tables" style="--parallel-count: ${block.sections.length}">\n${sections.join('\n')}\n</div>`
  }
  if (isReportMetadata(block)) {
    return renderReportMetadata(block)
  }
  return renderTable(block)
}

function renderOrderedList(entries: OrderedListEntry[]): string {
  const parents: Array<{ entry: OrderedListEntry, children: OrderedListEntry[] }> = []
  for (const entry of entries) {
    if (entry.depth === 0 || parents.length === 0) {
      parents.push({ entry, children: [] })
      continue
    }
    parents.at(-1)!.children.push(entry)
  }

  const listAttributes = (listEntries: OrderedListEntry[]) => {
    const type = listEntries.every(entry => entry.marker === 'lower-alpha')
      ? ' type="a"'
      : ''
    const start = listEntries[0]?.ordinal !== 1
      ? ` start="${listEntries[0]!.ordinal}"`
      : ''
    return `${type}${start}`
  }
  const renderEntries = (listEntries: OrderedListEntry[]) => {
    let expectedOrdinal = listEntries[0]?.ordinal ?? 1
    return listEntries.map((entry) => {
      const value = entry.ordinal === expectedOrdinal ? '' : ` value="${entry.ordinal}"`
      expectedOrdinal = entry.ordinal + 1
      return `<li${value}>${renderInline(entry.text)}</li>`
    }).join('\n')
  }
  const renderedEntries = parents.map((parent, parentIndex) => {
    const children = parent.children.length === 0
      ? ''
      : `\n<ol${listAttributes(parent.children)}>\n${renderEntries(parent.children)}\n</ol>`
    const previousOrdinal = parents[parentIndex - 1]?.entry.ordinal
    const expectedOrdinal = previousOrdinal === undefined
      ? parent.entry.ordinal
      : previousOrdinal + 1
    const value = parent.entry.ordinal === expectedOrdinal
      ? ''
      : ` value="${parent.entry.ordinal}"`
    return `<li${value}>${renderInline(parent.entry.text)}${children}</li>`
  })
  return `<ol${listAttributes(parents.map(parent => parent.entry))}>\n${renderedEntries.join('\n')}\n</ol>`
}

function isReportMetadata(table: TableBlock): boolean {
  const rows = [table.header, ...table.body.flatMap(row => row.kind === 'row' ? [row.cells] : [])]
    .filter(row => row.some(cell => cell.length > 0))
  if (table.header.length > 3 || rows.length > 4) {
    return false
  }
  const metadataValues = rows.flat().filter(value =>
    /\b(?:Page \d+ of \d+|Reports?\b|As of\b)|\bv\d+(?:\.\d+)*\b|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}|^\d+(?:\.\d+){2,}$/i.test(value))
  return metadataValues.length >= 2
}

function renderReportMetadata(table: TableBlock): string {
  const rows = [table.header, ...table.body.flatMap(row => row.kind === 'row' ? [row.cells] : [])]
    .filter(row => row.some(cell => cell.length > 0))
  const content = rows.map(row =>
    `<p class="metadata-row">${row.filter(Boolean).map(value => `<span>${renderInline(value)}</span>`).join('')}</p>`)
    .join('\n')
  return `<header class="report-metadata">\n${content}\n</header>`
}

function renderTable(table: TableBlock): string {
  const columnCount = table.header.length
  const tableRows = table.body.filter((row): row is TableRow => row.kind === 'row')
  const trailingColumn = columnCount - 1
  const precedingColumn = trailingColumn - 1
  const trailingNotes = tableRows
    .map(row => row.cells[trailingColumn] ?? '')
    .filter(Boolean)
  const precedingNumericCount = tableRows.filter(row =>
    parseFinancialValue(row.cells[precedingColumn] ?? '') !== undefined).length
  const hasTrailingNotes = columnCount >= 3
    && table.header.every(cell => cell.length === 0)
    && trailingNotes.length >= 2
    && trailingNotes.length < tableRows.length
    && trailingNotes.every(note => parseFinancialValue(note) === undefined)
    && precedingNumericCount >= Math.max(3, Math.ceil(tableRows.length * 0.6))
  if (hasTrailingNotes) {
    const primaryTable: TableBlock = {
      kind: 'table',
      header: table.header.slice(0, trailingColumn),
      body: table.body.map(row => row.kind === 'section'
        ? row
        : { kind: 'row', cells: row.cells.slice(0, trailingColumn) }),
    }
    const notes = trailingNotes.map(note => `<p>${renderInline(note)}</p>`).join('\n')
    return `<div class="table-with-notes">\n${renderTable(primaryTable)}\n<aside>\n${notes}\n</aside>\n</div>`
  }
  const header = table.header.some(cell => cell.length > 0)
    ? `<thead>\n${renderTableHeader(table.header)}\n</thead>\n`
    : ''
  const inferredTotal = inferUnlabeledTotal(table.body, columnCount)
  const body = inferredTotal ? table.body.slice(0, -1) : table.body
  const rows = body.map((row) => {
    if (row.kind === 'section') {
      return `<tr class="section"><th colspan="${columnCount}" scope="rowgroup">${renderInline(row.label)}</th></tr>`
    }
    const summary = row.cells.some(cell =>
      /^(?:(?:Grand )?Totals?\b|\d{5}-\d{3}\s+TOTAL\b)/i.test(cell.replaceAll('**', '')))
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => {
      const value = row.cells[columnIndex] ?? ''
      const tag = columnIndex === 0 && value.length > 0 ? 'th' : 'td'
      const scope = tag === 'th' ? ' scope="row"' : ''
      return `<${tag}${scope}>${renderInline(value)}</${tag}>`
    })
    return `<tr${summary ? ' class="summary"' : ''}>${cells.join('')}</tr>`
  }).join('\n')
  const footer = inferredTotal
    ? `\n<tfoot>\n${renderInferredTotal(inferredTotal, columnCount)}\n</tfoot>`
    : ''
  return `<table>\n${header}<tbody>\n${rows}\n</tbody>${footer}\n</table>`
}

function inferUnlabeledTotal(
  body: Array<TableRow | TableSectionRow>,
  columnCount: number,
): TableRow | undefined {
  const candidate = body.at(-1)
  if (candidate?.kind !== 'row' || candidate.cells[0] || body.length < 3) {
    return undefined
  }
  const candidateValues = candidate.cells.map(parseFinancialValue)
  const numericColumns = candidateValues.flatMap((value, columnIndex) =>
    value === undefined ? [] : [columnIndex])
  const populatedCells = candidate.cells.filter(Boolean)
  if (numericColumns.length < 3 || numericColumns.length !== populatedCells.length) {
    return undefined
  }

  const precedingRows = body.slice(0, -1).filter((row): row is TableRow => row.kind === 'row')
  const reconciles = numericColumns.every((columnIndex) => {
    const values = precedingRows.flatMap((row) => {
      const value = parseFinancialValue(row.cells[columnIndex] ?? '')
      return value === undefined ? [] : [value]
    })
    if (values.length < 2) {
      return false
    }
    const sum = values.reduce((total, value) => total + value, 0)
    return Math.abs(sum - candidateValues[columnIndex]!) < 0.005
  })
  return reconciles && candidate.cells.length <= columnCount ? candidate : undefined
}

function parseFinancialValue(cell: string): number | undefined {
  const value = cell.replaceAll('**', '').trim()
  if (!/^\(?-?\$?\d[\d,]*(?:\.\d+)?%?\)?$/.test(value)) {
    return undefined
  }
  const magnitude = Number(value.replace(/[$,%()]/g, ''))
  return value.startsWith('(') ? -magnitude : magnitude
}

function renderInferredTotal(row: TableRow, columnCount: number): string {
  const values = Array.from({ length: columnCount }, (_, columnIndex) => {
    const value = row.cells[columnIndex] ?? ''
    return `<td>${renderInline(value)}</td>`
  })
  return `<tr class="summary">${values.join('')}</tr>`
}

function renderTableHeader(header: string[]): string {
  const anchoredGroups = inferAnchoredColumnGroups(header)
  if (anchoredGroups.length > 1) {
    const groupRow: string[] = []
    const firstGroup = anchoredGroups[0]!
    if (firstGroup.start > 0) {
      groupRow.push(`<th aria-hidden="true" colspan="${firstGroup.start}"></th>`)
    }
    for (const group of anchoredGroups) {
      groupRow.push(`<th colspan="${group.end - group.start}" scope="colgroup">${renderInline(group.label)}</th>`)
    }
    const lastGroup = anchoredGroups.at(-1)!
    if (lastGroup.end < header.length) {
      groupRow.push(`<th aria-hidden="true" colspan="${header.length - lastGroup.end}"></th>`)
    }
    const columnRow = header.map(cell => `<th scope="col">${renderInline(cell)}</th>`).join('')
    return `<tr>${groupRow.join('')}</tr>\n<tr>${columnRow}</tr>`
  }

  return `<tr>${header.map(cell => `<th scope="col">${renderInline(cell)}</th>`).join('')}</tr>`
}

function inferAnchoredColumnGroups(header: string[]): Array<{
  start: number
  end: number
  label: string
}> {
  const anchors = header.flatMap((cell, columnIndex) => {
    const match = /^Total<br>([A-Za-z][A-Za-z -]+)$/.exec(cell)
    return match ? [{ start: columnIndex, label: match[1]! }] : []
  })
  if (anchors.length < 2) {
    return []
  }
  const groups = anchors.map((anchor, anchorIndex) => {
    const nextAnchor = anchors[anchorIndex + 1]
    const trailingMetric = header.findIndex((cell, columnIndex) =>
      columnIndex > anchor.start && /^(?:Occupancy|Average|Avg|Net)\b/.test(cell))
    const end = nextAnchor?.start
      ?? (trailingMetric > anchor.start ? trailingMetric : header.length)
    return { ...anchor, end }
  })
  return groups.every(group => group.end - group.start > 1) ? groups : []
}

function renderInline(value: string): string {
  const unescaped = value.replace(/\\([\\|#])/g, '$1')
  if (unescaped.startsWith('**') && unescaped.endsWith('**')) {
    const emphasized = unescaped.slice(2, -2)
      .split('<br>')
      .map(escapeHTML)
      .join('<br>')
    return `<strong>${emphasized}</strong>`
  }
  return unescaped.split('<br>').map((part) => {
    const escaped = escapeHTML(part)
    return escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>')
  }).join('<br>')
}

function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function inferHeaderRowCount(
  rows: string[][],
  isNumericCell: (cell: string) => boolean,
): number {
  const firstDataRow = rows.findIndex((row, rowIndex) => {
    const populatedCells = row.filter(cell => cell.length > 0)
    const numericCells = row.filter((cell, columnIndex) =>
      (isNumericCell(cell) || /^\(?-?\$?\d[\d,]*\.\d{2}\)?\s+\S/.test(cell))
      && !(/^\d{1,3}$/.test(cell) && /[a-z]/i.test(rows[rowIndex + 1]?.[columnIndex] ?? '')))
    return populatedCells.length >= 2
      && numericCells.length >= Math.max(1, Math.ceil(populatedCells.length / 3))
  })
  if (firstDataRow > 0) {
    const headerRows = rows.slice(0, firstDataRow)
    const recordIdentifier = /^(?=.*\d)[a-z0-9][a-z0-9.-]*$/i
    const firstSparseRecord = headerRows.findIndex((row, rowIndex) =>
      rowIndex > 0
      && row.filter(Boolean).length <= 2
      && recordIdentifier.test(row[0] ?? '')
      && rows.slice(firstDataRow).some(record => recordIdentifier.test(record[0] ?? '')))
    if (firstSparseRecord > 0) {
      return firstSparseRecord
    }
    const headerRowsAreTabular = headerRows
      .every(row => row.some(cell => cell.length > 0) && row.every((cell, columnIndex) =>
        !isNumericCell(cell)
        || (/^\d{1,3}$/.test(cell) && headerRows.some(otherRow =>
          /[a-z]/i.test(otherRow[columnIndex] ?? '')))))
        && headerRows.filter(row => row.filter(cell => cell.length > 0).length >= 2).length >= 2
    if (headerRowsAreTabular) {
      return firstDataRow
    }
  }

  const firstRow = rows[0]!
  const populatedHeaderCells = firstRow.filter(cell => cell.length > 0)
  const hasSingleHeader = populatedHeaderCells.length >= 2
    && populatedHeaderCells.every(cell => !isNumericCell(cell))
    && rows.slice(1).some(row => row.some((cell, columnIndex) =>
      isNumericCell(cell) && !isNumericCell(firstRow[columnIndex] ?? ''),
    ))
  return hasSingleHeader ? 1 : 0
}

function combineHeaderRows(rows: string[][], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const labels = rows
      .map(row => row[columnIndex] ?? '')
      .filter((label, labelIndex, allLabels) =>
        label.length > 0 && allLabels.indexOf(label) === labelIndex)
    return labels.join('<br>')
  })
}

function stitchWrappedRows(
  rows: string[][],
  columnCount: number,
  isNumericCell: (cell: string) => boolean,
  header: string[],
  layout?: {
    maximumContinuationGap: number
    visualPositions: (row: string[]) => number[]
  },
): string[][] {
  const populatedCells = (row: string[]) => row.filter(cell => cell.length > 0)
  const isRecordRow = (row: string[]) => {
    const populated = populatedCells(row)
    return populated.length >= 3 || populated.filter(isNumericCell).length >= 2
  }
  if (rows.length === 0) {
    return rows
  }

  const canMerge = (row: string[]) => {
    const populated = populatedCells(row)
    return populated.length > 0
      && populated.length <= 2
      && populated.every(cell =>
        !isNumericCell(cell) || /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(cell))
      && populated.every(cell => !/^(?:(?:Grand )?Total\b|\d{5}-\d{3}\b|PULL:)/i.test(cell))
      && populated.every(cell => !/^Page \d/i.test(cell))
  }
  const isTrailingFinancialContinuation = (row: string[]) => {
    const populatedColumnIndexes = row.flatMap((cell, columnIndex) =>
      cell ? [columnIndex] : [])
    const populatedValues = populatedColumnIndexes.map(columnIndex => row[columnIndex]!)
    return populatedColumnIndexes.length >= 1
      && populatedColumnIndexes.length <= 4
      && populatedColumnIndexes[0]! >= Math.floor(columnCount / 2)
      && populatedColumnIndexes.every(columnIndex => isNumericCell(row[columnIndex]!))
      && !populatedValues.every(value => /^(?:19|20)\d{2}$/.test(value))
  }

  let stitchedRows: string[][]
  if (!isRecordRow(rows[0]!)) {
    const startsIdentifiedRecord = (row: string[]) =>
      /^(?=.*\d)[a-z0-9][a-z0-9.-]*$/i.test(row[0] ?? '')
    const recordIndexes = rows.flatMap((row, rowIndex) =>
      (isRecordRow(row) || startsIdentifiedRecord(row))
      && !isTrailingFinancialContinuation(row)
        ? [rowIndex]
        : [])
    if (recordIndexes.length === 0) {
      return rows
    }

    const stitched = rows.map(row => [...row])
    const mergedRows = new Set<number>()
    for (const [rowIndex, row] of rows.entries()) {
      const trailingFinancialValues = isTrailingFinancialContinuation(row)
      if (!canMerge(row) && !trailingFinancialValues) {
        continue
      }
      const recordIndex = recordIndexes.reduce((nearest, candidate) =>
        Math.abs(candidate - rowIndex) < Math.abs(nearest - rowIndex)
          ? candidate
          : nearest)
      const record = stitched[recordIndex]!
      if (row[0] && record[0]) {
        continue
      }
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const continuation = row[columnIndex]
        if (!continuation) {
          continue
        }
        const recordCell = record[columnIndex]
        record[columnIndex] = recordCell && recordCell !== '-'
          ? rowIndex < recordIndex
            ? `${continuation}<br>${recordCell}`
            : `${recordCell}<br>${continuation}`
          : continuation
      }
      if (trailingFinancialValues) {
        for (let columnIndex = 1; columnIndex < columnCount; columnIndex++) {
          const packedValue = /^-\s+([+\-]?\$?\(?\d[\d,.]*\)?)$/.exec(record[columnIndex] ?? '')
          if (packedValue && record[columnIndex - 1]) {
            record[columnIndex] = packedValue[1]!
          }
        }
      }
      mergedRows.add(rowIndex)
    }
    stitchedRows = stitched.filter((_, rowIndex) => !mergedRows.has(rowIndex))
  }
  else {
    stitchedRows = []
    for (const row of rows) {
      const previousRow = stitchedRows.at(-1)
      const populatedColumnIndexes = row.flatMap((cell, columnIndex) =>
        cell ? [columnIndex] : [])
      const previousPopulatedCount = previousRow?.filter(Boolean).length ?? 0
      const overlappingColumnCount = previousRow === undefined
        ? 0
        : populatedColumnIndexes.filter(columnIndex => previousRow[columnIndex]).length
      const rowPositions = layout?.visualPositions(row) ?? []
      const previousRowPositions = previousRow ? layout?.visualPositions(previousRow) ?? [] : []
      const followsClosely = rowPositions.some(rowPosition =>
        previousRowPositions.some(previousRowPosition =>
          Math.abs(rowPosition - previousRowPosition) <= layout!.maximumContinuationGap))
      const continuesDenseRecord = previousRow !== undefined
        && followsClosely
        && !row[0]
        && previousPopulatedCount >= 6
        && populatedColumnIndexes.length <= Math.max(4, Math.floor(previousPopulatedCount / 2))
        && overlappingColumnCount >= Math.max(1, populatedColumnIndexes.length - 1)
        && populatedColumnIndexes.some(columnIndex => !isNumericCell(row[columnIndex]!))
        && populatedColumnIndexes.every(columnIndex =>
          !/^(?:(?:Grand )?Total\b|\d{5}-\d{3}\b|PULL:)/i.test(row[columnIndex]!))
      const continuesTrailingFinancialValues = previousRow !== undefined
        && !row[0]
        && previousPopulatedCount >= 6
        && isTrailingFinancialContinuation(row)
      const splitTokenColumn = previousRow === undefined || populatedColumnIndexes.length !== 1
        ? undefined
        : populatedColumnIndexes[0]
      const previousCellParts = splitTokenColumn === undefined
        ? []
        : (previousRow?.[splitTokenColumn] ?? '').split('<br>')
      const continuesSplitToken = splitTokenColumn !== undefined
        && followsClosely
        && /^\d{1,4}$/.test(row[splitTokenColumn]!)
        && previousCellParts.length >= 2
        && previousCellParts[0]!.endsWith('-')
        && previousCellParts.slice(1).every(part => /^\d+$/.test(part))
      const continuesPreviousRow = stitchedRows.length > 0
        && (canMerge(row)
          || continuesDenseRecord
          || continuesTrailingFinancialValues
          || continuesSplitToken)
        && !(row[0] && previousRow?.[0])
      if (!continuesPreviousRow) {
        stitchedRows.push([...row])
        continue
      }

      const previousRowToExtend = stitchedRows.at(-1)!
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const continuation = row[columnIndex]
        if (!continuation) {
          continue
        }
        previousRowToExtend[columnIndex] = previousRowToExtend[columnIndex]
          && previousRowToExtend[columnIndex] !== '-'
          ? `${previousRowToExtend[columnIndex]}<br>${continuation}`
          : continuation
      }
      if (continuesTrailingFinancialValues) {
        for (let columnIndex = 1; columnIndex < columnCount; columnIndex++) {
          const packedValue = /^-\s+([+\-]?\$?\(?\d[\d,.]*\)?)$/.exec(
            previousRowToExtend[columnIndex] ?? '',
          )
          if (packedValue && previousRowToExtend[columnIndex - 1]) {
            previousRowToExtend[columnIndex] = packedValue[1]!
          }
        }
      }
    }
  }

  const unitColumn = header.findIndex(cell => /^Unit$/i.test(cell))
  const nameColumn = header.findIndex(cell =>
    /^(?:Name(?:<br>|\s|$)|Phone Number(?:<br>|\s)Email)/i.test(cell))
  const statusColumn = header.findIndex(cell => /^Status$/i.test(cell))
  const transactionColumn = header.findIndex(cell =>
    /^(?:Date|Transaction(?:<br>|\s)Code|Code(?:<br>|\s)Description)$/.test(cell))
  if (
    unitColumn !== 0
    || nameColumn <= unitColumn
    || statusColumn <= nameColumn
    || transactionColumn <= statusColumn
  ) {
    return stitchedRows
  }

  const transactionRows: string[][] = []
  let accountRow: string[] | undefined
  for (const row of stitchedRows) {
    if (row[unitColumn]) {
      accountRow = [...row]
      transactionRows.push(accountRow)
      continue
    }
    if (!accountRow) {
      transactionRows.push([...row])
      continue
    }

    const transactionCells = row.slice(transactionColumn).filter(Boolean)
    const startsTransaction = transactionCells.length >= 2
      || transactionCells.some(isNumericCell)
    for (let columnIndex = unitColumn + 1; columnIndex < transactionColumn; columnIndex++) {
      const continuation = row[columnIndex]
      if (!continuation) {
        continue
      }
      accountRow[columnIndex] = accountRow[columnIndex]
        ? `${accountRow[columnIndex]}<br>${continuation}`
        : continuation
      row[columnIndex] = ''
    }

    if (startsTransaction) {
      transactionRows.push([...row])
      continue
    }
    for (let columnIndex = transactionColumn; columnIndex < columnCount; columnIndex++) {
      const continuation = row[columnIndex]
      if (!continuation) {
        continue
      }
      accountRow[columnIndex] = accountRow[columnIndex]
        ? `${accountRow[columnIndex]}<br>${continuation}`
        : continuation
    }
  }

  accountRow = undefined
  return transactionRows.map((row) => {
    if (row[unitColumn]) {
      accountRow = row
      return row
    }
    if (!accountRow) {
      return row
    }
    return row.map((cell, columnIndex) =>
      columnIndex < transactionColumn ? accountRow![columnIndex] ?? '' : cell)
  })
}

function emphasizeSummaryRow(row: string[]): string[] {
  const firstValue = row.find(cell => cell.length > 0)
  if (!firstValue || !/^(?:(?:Grand )?Total\b|\d{5}-\d{3}\s+TOTAL\b)/i.test(firstValue)) {
    return row
  }
  return row.map(cell => cell.length > 0 ? `**${cell}**` : cell)
}

function inheritContinuationContext(structuredPages: string[]): void {
  for (let pageIndex = 1; pageIndex < structuredPages.length; pageIndex++) {
    const page = structuredPages[pageIndex]!
    if (!/^\| /m.test(page)) {
      continue
    }

    const previousPage = structuredPages[pageIndex - 1]!
    const previousTitle = /^# (.+)$/m.exec(previousPage)?.[1]
      ?.replace(/ \(continued\)$/, '')
    if (!previousTitle || /^\(?continued\)?$/i.test(previousTitle)) {
      continue
    }

    const previousHeaders = tableHeadersByColumnCount(previousPage)
    const lines = page.split('\n')
    let inheritedTableContext = false
    const pageTitle = inferPageTitleBeforeTable(lines)
    if (pageTitle) {
      const titleIndex = lines.indexOf(pageTitle)
      lines[titleIndex] = `# ${pageTitle}`
    }
    for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
      const cells = structuredTableCells(lines[lineIndex]!)
      if (
        !cells
        || !/^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1]!)
      ) {
        continue
      }
      const precedingLines = lines.slice(0, lineIndex)
      const localCaptionIndex = precedingLines.findLastIndex(line =>
        /\bTable \d+[a-z]?\./i.test(line))
      const localTableRows = precedingLines
        .slice(localCaptionIndex + 1)
        .filter(line => !/^\|(?:\s*---\s*\|)+$/.test(line))
        .flatMap(line => structuredTableCells(line) ?? [])
      const localCaptionIntroducesTable = localCaptionIndex >= 0
        && localTableRows.every(cell =>
          !isStructuredNumericCell(cell.replaceAll('**', '')))
      if (localCaptionIntroducesTable) {
        continue
      }

      if (cells.every(cell => cell.length === 0)) {
        const inheritedHeader = previousHeaders.get(cells.length)
        if (inheritedHeader && cells.length >= 4) {
          lines[lineIndex] = inheritedHeader
          inheritedTableContext = true
        }
        continue
      }

      const compatibleHeader = [...previousHeaders.entries()]
        .filter(([columnCount, header]) => {
          const currentSection = lines.slice(0, lineIndex)
            .findLast(line => line.startsWith('## '))
          if (currentSection && !previousPage.split('\n').includes(currentSection)) {
            return false
          }
          if (columnCount <= cells.length) {
            return false
          }
          const previousHeaderCells = structuredTableCells(header)
          if (!previousHeaderCells) {
            return false
          }
          const packedCellCount = cells.filter(cell =>
            previousHeaderCells.filter(previousCell =>
              headerWordOverlap(cell, previousCell) > 0).length >= 2).length
          return packedCellCount >= 2
            && headerWordOverlap(lines[lineIndex]!, header) >= 4
            && firstHeaderCellOverlap(lines[lineIndex]!, header) >= 1
        })
        .sort((left, right) => left[0] - right[0])[0]
      if (!compatibleHeader) {
        continue
      }

      const [columnCount, inheritedHeader] = compatibleHeader
      lines[lineIndex] = inheritedHeader
      inheritedTableContext = true
      lines[lineIndex + 1] = renderStructuredRow(
        Array.from<string>({ length: columnCount }).fill('---'),
      )
      const possibleStackedHeader = structuredTableCells(lines[lineIndex + 2] ?? '')
      if (
        possibleStackedHeader
        && possibleStackedHeader.every(cell => !isStructuredNumericCell(cell.replaceAll('**', '')))
        && headerWordOverlap(lines[lineIndex + 2]!, inheritedHeader) >= 3
      ) {
        lines.splice(lineIndex + 2, 1)
      }
      for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex++) {
        const row = structuredTableCells(lines[rowIndex]!)
        if (!row) {
          break
        }
        const expandedRow = expandPackedNumericCells(row, columnCount)
        if (expandedRow) {
          lines[rowIndex] = renderStructuredRow(expandedRow)
        }
      }
    }

    const previousLines = previousPage.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
      const header = structuredTableCells(lines[lineIndex]!)
      if (
        !header
        || !/^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1]!)
      ) {
        continue
      }
      const unitColumn = header.findIndex(cell => /^Unit$/i.test(cell))
      const nameColumn = header.findIndex(cell =>
        /^(?:Name(?:<br>|\s|$)|Phone Number(?:<br>|\s)Email)/i.test(cell))
      const statusColumn = header.findIndex(cell => /^Status$/i.test(cell))
      const transactionColumn = header.findIndex(cell =>
        /^(?:Date|Transaction(?:<br>|\s)Code|Code(?:<br>|\s)Description)$/.test(cell))
      if (
        unitColumn !== 0
        || nameColumn <= unitColumn
        || statusColumn <= nameColumn
        || transactionColumn <= statusColumn
      ) {
        continue
      }

      let previousAccount: string[] | undefined
      for (let previousLineIndex = 0; previousLineIndex < previousLines.length - 1; previousLineIndex++) {
        const previousHeader = structuredTableCells(previousLines[previousLineIndex]!)
        if (
          !previousHeader
          || previousHeader.length !== header.length
          || !/^\|(?:\s*---\s*\|)+$/.test(previousLines[previousLineIndex + 1]!)
          || headerWordOverlap(lines[lineIndex]!, previousLines[previousLineIndex]!) < 4
        ) {
          continue
        }
        for (let rowIndex = previousLineIndex + 2; rowIndex < previousLines.length; rowIndex++) {
          const row = structuredTableCells(previousLines[rowIndex]!)
          if (!row) {
            break
          }
          if (row[unitColumn]) {
            previousAccount = row
          }
        }
      }
      if (!previousAccount) {
        continue
      }

      for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex++) {
        const row = structuredTableCells(lines[rowIndex]!)
        if (!row || row[unitColumn]) {
          break
        }
        for (let columnIndex = unitColumn; columnIndex < transactionColumn; columnIndex++) {
          row[columnIndex] = previousAccount[columnIndex] ?? ''
        }
        lines[rowIndex] = renderStructuredRow(row)
      }
      inheritedTableContext = true
    }
    const inheritedPage = lines.join('\n')
    const firstTableLine = lines.findIndex(line => structuredTableCells(line) !== undefined)
    const hasLeadingContent = lines
      .slice(0, firstTableLine < 0 ? lines.length : firstTableLine)
      .some(line => line.length > 0 && !/^\d+$/.test(line))
    structuredPages[pageIndex] = /^# /m.test(inheritedPage)
      || !inheritedTableContext
      || hasLeadingContent
      ? inheritedPage
      : `# ${previousTitle} (continued)\n\n${inheritedPage}`
  }
}

function inferPageTitleBeforeTable(lines: string[]): string | undefined {
  if (lines.some(line => line.startsWith('# '))) {
    return undefined
  }
  const firstTableLine = lines.findIndex(line => structuredTableCells(line) !== undefined)
  const leadingLines = lines.slice(0, firstTableLine < 0 ? lines.length : firstTableLine)
  const candidates = leadingLines.filter((line) => {
    const words = line.match(/[a-z][a-z'-]*/gi) ?? []
    const firstLetter = line.match(/[a-z]/i)?.[0]
    return line.length >= 4
      && line.length <= 100
      && words.length >= 2
      && words.length <= 12
      && firstLetter === firstLetter?.toUpperCase()
      && !/^(?:As of|Parameters?|Period|Book|Sort On|Posted by|Fiscal Period|Report Date|For \d)/i.test(line)
      && !/[.!?;]$|https?:\/\/|\S+@\S+/.test(line)
  })
  return candidates
    .flatMap(shorter => candidates.some(longer =>
      longer !== shorter
      && longer.toLowerCase().endsWith(shorter.toLowerCase()))
      ? [shorter]
      : [])
    .sort((left, right) => right.length - left.length)[0]
}

function headerWordOverlap(left: string, right: string): number {
  const words = (value: string) => new Set(
    value.replaceAll(/[*|<>/]/g, ' ').toLowerCase().match(/[a-z]{3,}/g) ?? [],
  )
  const leftWords = words(left)
  return [...words(right)].filter(word => leftWords.has(word)).length
}

function firstHeaderCellOverlap(left: string, right: string): number {
  const words = (value: string) => new Set(
    (structuredTableCells(value)?.[0] ?? '')
      .replaceAll(/[*<>/]/g, ' ')
      .toLowerCase()
      .match(/[a-z]{3,}/g) ?? [],
  )
  const leftWords = words(left)
  return [...words(right)].filter(word => leftWords.has(word)).length
}

function expandPackedNumericCells(cells: string[], columnCount: number): string[] | undefined {
  const expanded = cells.flatMap((cell) => {
    const isStrong = cell.startsWith('**') && cell.endsWith('**')
    const value = isStrong ? cell.slice(2, -2) : cell
    const tokens = value.split(/\s+/).filter(Boolean)
    if (tokens.length <= 1 || !tokens.every(isStructuredNumericCell)) {
      return [cell]
    }
    return tokens.map(token => isStrong ? `**${token}**` : token)
  })
  return expanded.length === columnCount ? expanded : undefined
}

function renderStructuredRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function tableHeadersByColumnCount(page: string): Map<number, string> {
  const headers = new Map<number, string>()
  const lines = page.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
    const cells = structuredTableCells(lines[lineIndex]!)
    if (
      cells
      && cells.some(cell => cell.length > 0)
      && /^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1]!)
    ) {
      headers.set(cells.length, lines[lineIndex]!)
      continue
    }
    if (
      cells
      && cells.every(cell => cell.length === 0)
      && /^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1]!)
    ) {
      const stackedRows: string[][] = []
      for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex++) {
        const row = structuredTableCells(lines[rowIndex]!)
        if (
          !row
          || row.some(cell => isStructuredNumericCell(cell.replaceAll('**', '')))
          || stackedRows.length === 4
        ) {
          break
        }
        stackedRows.push(row)
      }
      if (stackedRows.length > 0) {
        headers.set(
          cells.length,
          renderStructuredRow(combineHeaderRows(stackedRows, cells.length)),
        )
      }
    }
  }
  return headers
}

function structuredTableCells(line: string): string[] | undefined {
  if (!line.startsWith('| ') || !line.endsWith(' |')) {
    return undefined
  }
  return line.slice(2, -2).split(/(?<!\\)\|/).map(cell => cell.trim())
}
