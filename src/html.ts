import type { DocumentInitParameters, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { extractText, extractTextItems } from './text'
import { getDocumentProxy, isPDFDocumentProxy } from './utils'

export interface ExtractHTMLOptions {
  mergePages?: boolean
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
  const { mergePages = false } = options
  const ownsDocument = !isPDFDocumentProxy(data)
  const document = ownsDocument ? await getDocumentProxy(data) : data
  let extractedText: { totalPages: number, text: string[] }
  let extractedItems: Awaited<ReturnType<typeof extractTextItems>>

  try {
    extractedText = await extractText(document, { readingOrder: 'visual' })
    extractedItems = await extractTextItems(document)
  }
  finally {
    if (ownsDocument) {
      await document.cleanup()
    }
  }
  const { text, totalPages } = extractedText
  const structuredPages = text.map((pageText, pageIndex) => {
    const lines = pageText.split('\n')
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
        lines[entry.lineIndex] = `   ${entry.ordinal}. ${entry.text}`
      }
    }
    const fontSizesByText = new Map<string, number[]>()
    for (const item of extractedItems.items[pageIndex] ?? []) {
      const sizes = fontSizesByText.get(item.str) ?? []
      sizes.push(item.fontSize)
      fontSizesByText.set(item.str, sizes)
    }
    const pageFontSizes = [...fontSizesByText.values()]
      .flat()
      .sort((left, right) => left - right)
    const medianPageFontSize = pageFontSizes[Math.floor(pageFontSizes.length / 2)] ?? 0
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
          && words.length >= 2
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
      const pageItems = extractedItems.items[pageIndex] ?? []
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
        const values = row.filter(Boolean).map(cell => cell.replace(/\\([\\|#])/g, '$1'))
        const matchesByValue = values.map(value =>
          pageItems.filter(item => item.str === value))
          .filter(matches => matches.length > 0)
          .sort((left, right) => left.length - right.length)
        const baselines = (matchesByValue[0] ?? [])
          .map(item => item.y)
          .sort((left, right) => left - right)
        return baselines[Math.floor(baselines.length / 2)]
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

      const leadingRow = rows[0]
      if (leadingRow) {
        const separatedLabels = leadingRow.flatMap((cell, columnIndex) => {
          const combinedLabel = cell.replace(/\\([\\|#])/g, '$1')
          const possibleParts = pageItems.filter(item =>
            item.str.trim().length > 0 && combinedLabel.includes(item.str))
          const separatedPair = possibleParts.flatMap(left => possibleParts.flatMap((right) => {
            const sameLine = Math.abs(left.y - right.y) <= Math.max(left.fontSize, right.fontSize) * 0.2
            const gap = right.x - (left.x + left.width)
            return sameLine
              && gap >= Math.max(left.fontSize, right.fontSize) * 1.5
              && `${left.str} ${right.str}` === combinedLabel
              ? [{ left, right, gap }]
              : []
          })).sort((left, right) => right.gap - left.gap)[0]
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

          const targetColumn = headerColumns.findLastIndex(headerColumn =>
            headerColumn.x <= positionedItem.x + headerColumn.fontSize * 0.5)
          return targetColumn >= 0 ? targetColumn : 0
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
            const values = rows.slice(1)
              .map(row => (row[columnIndex] ?? '').replace(/\\([\\|#])/g, '$1'))
              .filter(Boolean)
            const positions = values.flatMap((value) => {
              const exactMatches = bodyItems.filter(item => item.str === value)
              const matchingItems = exactMatches.length > 0
                ? exactMatches
                : bodyItems.filter(item =>
                    item.str.trim().length >= 4 && value.includes(item.str))
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
        ).filter(columnIndex => rows.slice(1).some(row => (row[columnIndex] ?? '').length > 0))
        const leadingRowIntroducesRecords = (rows[1] ?? [])
          .filter(isNumericCell)
          .length >= 2
        const headerContainsUnrepresentedColumns
          = populatedSourceColumns.length < headerColumns.length
        const canRebuildColumns = (separatedLabels.length > 0 || headerContainsUnrepresentedColumns)
          && leadingRowIntroducesRecords
          && headerColumns.length >= 2
          && populatedSourceColumns.every(columnIndex =>
            sourceColumnTargets[columnIndex] !== undefined)
        if (canRebuildColumns) {
          const rebuiltRows = rows.slice(1).map((row) => {
            const rebuiltRow = Array.from<string>({ length: headerColumns.length }).fill('')
            for (const [sourceColumn, value] of row.entries()) {
              if (!value) {
                continue
              }
              const sourceValue = value.replace(/\\([\\|#])/g, '$1')
              const exactMatches = bodyItems.filter(item => item.str === sourceValue)
              const componentMatches = exactMatches.length > 0
                ? exactMatches
                : bodyItems.filter(item =>
                    item.str.trim().length >= 4 && sourceValue.includes(item.str))
              const componentTargets = new Map<number, string[]>()
              for (const component of componentMatches) {
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
            headerColumns.map(item => item.str
              .replaceAll('\\', '\\\\')
              .replaceAll('|', '\\|')),
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
            const bodyValuePositions = rows.slice(1).flatMap((row) => {
              const value = (row[separatedLabel.columnIndex] ?? '').replace(/\\([\\|#])/g, '$1')
              if (!value) {
                return []
              }
              return pageItems.filter(item => item.str === value).map(item => item.x)
            }).sort((left, right) => left - right)
            const bodyPosition = bodyValuePositions[Math.floor(bodyValuePositions.length / 2)]
            if (bodyPosition === undefined) {
              continue
            }
            const valuesAlignWithRightLabel = Math.abs(bodyPosition - separatedLabel.right.x)
              < Math.abs(bodyPosition - separatedLabel.left.x)
            leadingRow.splice(
              separatedLabel.columnIndex,
              1,
              separatedLabel.left.str,
              separatedLabel.right.str,
            )
            for (const row of rows.slice(1)) {
              const value = row[separatedLabel.columnIndex] ?? ''
              row.splice(
                separatedLabel.columnIndex,
                1,
                ...(valuesAlignWithRightLabel ? ['', value] : [value, '']),
              )
            }
          }
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
      const leadingCaption = leadingCaptionCells.length === 1
        && leadingCaptionCells[0]!.columnIndex > 0
        && followingRowsLookLikeHeaders
        && nearbyRowContainsValues
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
        && !/[.!?:;]$|https?:\/\/|\S+@\S+|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(precedingHeaderLabel)
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
      if (lineIndex < lines.length && lines[lineIndex] !== '') {
        structuredLines.push('')
      }
    }

    return structuredLines.join('\n').trim()
  })

  inheritContinuationContext(structuredPages)
  const articles = structuredPages.map((page, pageIndex) =>
    renderPageArticle(page, pageIndex + 1))

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
    | { kind: 'ordered-list', entries: Array<{ depth: number, text: string }> }
    | { kind: 'unordered-list', entries: string[] }
    | { kind: 'paragraph', lines: string[] }
    | { kind: 'blockquote', lines: string[] }
    | ParallelTablesBlock
    | TableBlock

function renderPageArticle(page: string, pageNumber: number): string {
  const blocks = mergeTableSections(enrichTableHeaders(
    splitParallelTables(attachTrailingCellContinuations(parsePageBlocks(page))),
  )).filter((block) => {
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
  return `<article class="pdf-page" data-page-number="${pageNumber}">\n${content}\n</article>`
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

    if (/^\s*\d+\.\s+/.test(line)) {
      const entries: Array<{ depth: number, text: string }> = []
      while (lineIndex < lines.length) {
        const entryLine = lines[lineIndex]!
        const marker = /^(\s*)\d+\. /.exec(entryLine)
        if (!marker) {
          break
        }
        entries.push({
          depth: Math.floor(marker[1]!.length / 3),
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
      if (
        /^(?:#{1,6}|- |> )/.test(candidate)
        || /^\s*\d+\.\s+/.test(candidate)
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

function mergeTableSections(blocks: PageBlock[]): PageBlock[] {
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
      if (
        bridgedLabels.length > 1
        && bridgedContinuation?.kind === 'table'
        && headersMatch(table.header, bridgedContinuation.header)
      ) {
        const alignedRows = bridgedContinuation.body.map((row) => {
          if (row.kind !== 'row' || row.cells.length >= table.header.length) {
            return row
          }
          return {
            kind: 'row' as const,
            cells: [
              ...Array.from<string>({ length: table.header.length - row.cells.length }).fill(''),
              ...row.cells,
            ],
          }
        })
        table.body.push(
          ...bridgedLabels.map(labelText => ({
            kind: 'row' as const,
            cells: [
              labelText,
              ...Array.from<string>({ length: table.header.length - 1 }).fill(''),
            ],
          })),
          ...alignedRows,
        )
        followingIndex = continuationIndex + 1
        continue
      }
      const label = blocks[followingIndex]!
      const continuation = blocks[followingIndex + 1]!
      const sparseRowLabels = label.kind === 'paragraph'
        && label.lines.length > 1
        && label.lines.every(line =>
          line.length <= 80
          && !/[.!?]$|https?:\/\/|\S+@\S+/.test(line))
        ? label.lines
        : undefined
      const sectionLabel = label.kind === 'heading' && label.level === 3
        ? label.text
        : label.kind === 'paragraph' && label.lines.length === 1
          ? label.lines[0]
          : undefined
      if (
        (!sectionLabel && !sparseRowLabels)
        || (sectionLabel?.length ?? 0) > 80
        || continuation.kind !== 'table'
        || !headersMatch(table.header, continuation.header)
      ) {
        break
      }
      const alignedRows = continuation.body.map((row) => {
        if (row.kind !== 'row' || row.cells.length >= table.header.length) {
          return row
        }
        return {
          kind: 'row' as const,
          cells: [
            ...Array.from<string>({ length: table.header.length - row.cells.length }).fill(''),
            ...row.cells,
          ],
        }
      })
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
        followingIndex += 2
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
    let leftHeading = tableHeading(block.header.slice(0, boundary))
    let rightHeading = tableHeading(block.header.slice(boundary))
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
            header: labels.slice(0, boundary),
            body: leftBody,
          },
          notes: [],
        },
        {
          heading: rightHeading,
          table: {
            kind: 'table',
            header: labels.slice(boundary),
            body: rightBody,
          },
          notes: rightNotes,
        },
      ],
    })
    blockIndex += consumedBlocks
  }
  return separated
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

function headersMatch(left: string[], right: string[]): boolean {
  if (Math.abs(left.length - right.length) > 1) {
    return false
  }
  const populatedLeft = left.some(cell => cell.length > 0)
  const populatedRight = right.some(cell => cell.length > 0)
  return !populatedLeft
    || !populatedRight
    || (left.length === right.length && left.every((cell, index) => cell === right[index]))
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
  const headerRowCount = firstRecordRow === -1
    && rows.length >= 2
    && rows.length <= 4
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

function renderOrderedList(entries: Array<{ depth: number, text: string }>): string {
  const parents: Array<{ text: string, children: string[] }> = []
  for (const entry of entries) {
    if (entry.depth === 0 || parents.length === 0) {
      parents.push({ text: entry.text, children: [] })
      continue
    }
    parents.at(-1)!.children.push(entry.text)
  }

  const renderedEntries = parents.map((parent) => {
    const children = parent.children.length === 0
      ? ''
      : `\n<ol>\n${parent.children.map(child => `<li>${renderInline(child)}</li>`).join('\n')}\n</ol>`
    return `<li>${renderInline(parent.text)}${children}</li>`
  })
  return `<ol>\n${renderedEntries.join('\n')}\n</ol>`
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

  let stitchedRows: string[][]
  if (!isRecordRow(rows[0]!)) {
    const recordIndexes = rows.flatMap((row, rowIndex) =>
      isRecordRow(row) ? [rowIndex] : [])
    if (recordIndexes.length === 0) {
      return rows
    }

    const stitched = rows.map(row => [...row])
    const mergedRows = new Set<number>()
    for (const [rowIndex, row] of rows.entries()) {
      if (!canMerge(row)) {
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
        record[columnIndex] = recordCell
          ? rowIndex < recordIndex
            ? `${continuation}<br>${recordCell}`
            : `${recordCell}<br>${continuation}`
          : continuation
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
        && (canMerge(row) || continuesDenseRecord || continuesSplitToken)
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
          ? `${previousRowToExtend[columnIndex]}<br>${continuation}`
          : continuation
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
    if (!previousTitle) {
      continue
    }

    const previousHeaders = tableHeadersByColumnCount(previousPage)
    const lines = page.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
      const cells = structuredTableCells(lines[lineIndex]!)
      if (
        !cells
        || !/^\|(?:\s*---\s*\|)+$/.test(lines[lineIndex + 1]!)
      ) {
        continue
      }

      if (cells.every(cell => cell.length === 0)) {
        const inheritedHeader = previousHeaders.get(cells.length)
        if (inheritedHeader && cells.length >= 4) {
          lines[lineIndex] = inheritedHeader
        }
        continue
      }

      const compatibleHeader = [...previousHeaders.entries()]
        .filter(([columnCount, header]) => {
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
    }
    const inheritedPage = lines.join('\n')
    structuredPages[pageIndex] = /^# /m.test(inheritedPage)
      ? inheritedPage
      : `# ${previousTitle} (continued)\n\n${inheritedPage}`
  }
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
