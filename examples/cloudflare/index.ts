/* eslint-disable no-console -- Worker observability uses structured stdout logs. */
import { extractTextPages } from '@mewhhaha/punpdf'

const MAX_PDF_BYTES = 16 * 1024 * 1024
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const textEncoder = new TextEncoder()

interface ExtractionJob {
  inputKey: string
  jobId: string
  outputPrefix: string
  readingOrder: 'visual'
}

interface ExtractionManifest {
  outputBytes: number
  totalPages: number
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/documents') {
        if (request.method !== 'POST')
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })

        if (!request.body)
          return Response.json({ error: 'The request body must contain a PDF' }, { status: 400 })

        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim()
        if (contentType !== 'application/pdf') {
          return Response.json({
            error: `Expected content-type application/pdf, received ${contentType ?? 'no content type'}`,
          }, { status: 415 })
        }

        const contentLengthHeader = request.headers.get('content-length')
        const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
        if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
          return Response.json({
            error: `Invalid content-length ${contentLengthHeader}`,
          }, { status: 400 })
        }
        if (contentLength !== undefined && contentLength > MAX_PDF_BYTES) {
          return Response.json({
            error: `PDF is ${contentLength} bytes; the maximum is ${MAX_PDF_BYTES}`,
          }, { status: 413 })
        }

        const jobId = crypto.randomUUID()
        const inputKey = `input/${jobId}.pdf`
        const outputPrefix = `output/${jobId}`
        const storedDocument = await env.DOCUMENTS.put(inputKey, request.body, {
          httpMetadata: { contentType: 'application/pdf' },
        })

        if (!storedDocument)
          throw new Error(`R2 did not store document ${jobId} at ${inputKey}`)

        if (storedDocument.size > MAX_PDF_BYTES) {
          await env.DOCUMENTS.delete(inputKey)
          return Response.json({
            error: `PDF is ${storedDocument.size} bytes; the maximum is ${MAX_PDF_BYTES}`,
          }, { status: 413 })
        }

        try {
          const extractionQueue: Queue<ExtractionJob> = env.EXTRACTION_QUEUE
          await extractionQueue.send({
            inputKey,
            jobId,
            outputPrefix,
            readingOrder: 'visual',
          })
        }
        catch (error) {
          await env.DOCUMENTS.delete(inputKey)
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`Could not enqueue document ${jobId}: ${reason}`, { cause: error })
        }

        console.log(JSON.stringify({
          event: 'document_queued',
          bytes: storedDocument.size,
          jobId,
        }))

        return Response.json({
          jobId,
          result: `${url.origin}/documents/${jobId}`,
          status: 'queued',
        }, { status: 202 })
      }

      const documentMatch = /^\/documents\/([^/]+)$/.exec(url.pathname)
      if (!documentMatch)
        return new Response('Not found', { status: 404 })

      if (request.method !== 'GET')
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })

      const jobId = documentMatch[1]!
      if (!DOCUMENT_ID_PATTERN.test(jobId)) {
        return Response.json({
          error: `Invalid document ID ${jobId}`,
        }, { status: 400 })
      }

      const outputPrefix = `output/${jobId}`
      const storedManifest = await env.DOCUMENTS.get(`${outputPrefix}/manifest.json`)
      if (storedManifest) {
        const manifest = await storedManifest.json<ExtractionManifest>()
        if (!Number.isSafeInteger(manifest.totalPages) || manifest.totalPages < 0) {
          throw new Error(
            `Document ${jobId} manifest has invalid totalPages ${manifest.totalPages}`,
          )
        }
        if (!Number.isSafeInteger(manifest.outputBytes) || manifest.outputBytes < 0) {
          throw new Error(
            `Document ${jobId} manifest has invalid outputBytes ${manifest.outputBytes}`,
          )
        }

        let pageNumber = 1
        let pageReader: ReadableStreamDefaultReader<Uint8Array> | undefined
        const textStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              while (pageNumber <= manifest.totalPages) {
                if (!pageReader) {
                  const pageKey = `${outputPrefix}/pages/${pageNumber.toString().padStart(6, '0')}.txt`
                  const storedPage = await env.DOCUMENTS.get(pageKey)
                  if (!storedPage)
                    throw new Error(`Document ${jobId} is missing extracted page ${pageNumber} at ${pageKey}`)

                  pageReader = storedPage.body.getReader()
                }

                const pageChunk = await pageReader.read()
                if (!pageChunk.done) {
                  controller.enqueue(pageChunk.value)
                  return
                }

                pageReader = undefined
                pageNumber++
              }

              controller.close()
            }
            catch (error) {
              controller.error(error)
            }
          },
          async cancel(reason) {
            await pageReader?.cancel(reason)
          },
        })

        return new Response(textStream, {
          headers: {
            'Content-Length': manifest.outputBytes.toString(),
            'Content-Type': 'text/plain; charset=utf-8',
            'ETag': storedManifest.httpEtag,
          },
        })
      }

      const sourceDocument = await env.DOCUMENTS.head(`input/${jobId}.pdf`)
      if (sourceDocument)
        return Response.json({ jobId, status: 'processing' }, { status: 202 })

      return Response.json({ error: `Document ${jobId} was not found` }, { status: 404 })
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(JSON.stringify({
        event: 'request_failed',
        method: request.method,
        path: url.pathname,
        reason,
      }))
      return Response.json({ error: 'Document request failed' }, { status: 500 })
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const startedAt = Date.now()
      const { inputKey, jobId, outputPrefix, readingOrder } = message.body

      try {
        if (await env.DOCUMENTS.head(`${outputPrefix}/manifest.json`)) {
          message.ack()
          continue
        }

        const sourceDocument = await env.DOCUMENTS.get(inputKey)
        if (!sourceDocument)
          throw new Error(`Document ${jobId} is missing from R2 key ${inputKey}`)
        if (sourceDocument.size > MAX_PDF_BYTES) {
          throw new Error(
            `Document ${jobId} is ${sourceDocument.size} bytes; the maximum is ${MAX_PDF_BYTES}`,
          )
        }

        const pdf = new Uint8Array(await sourceDocument.arrayBuffer())
        let totalPages = 0
        let outputBytes = 0

        for await (const page of extractTextPages(pdf, { readingOrder })) {
          const separator = page.pageNumber === 1 ? '' : '\n'
          const pageText = textEncoder.encode(separator + page.text)
          const pageKey = `${outputPrefix}/pages/${page.pageNumber.toString().padStart(6, '0')}.txt`
          const storedPage = await env.DOCUMENTS.put(pageKey, pageText, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          })
          if (!storedPage) {
            throw new Error(
              `R2 did not store extracted page ${page.pageNumber} for document ${jobId} at ${pageKey}`,
            )
          }

          outputBytes += storedPage.size
          totalPages = page.totalPages
        }

        const manifest: ExtractionManifest = { outputBytes, totalPages }
        const manifestKey = `${outputPrefix}/manifest.json`
        const storedManifest = await env.DOCUMENTS.put(manifestKey, JSON.stringify(manifest), {
          customMetadata: {
            inputKey,
            readingOrder,
          },
          httpMetadata: { contentType: 'application/json' },
        })
        if (!storedManifest)
          throw new Error(`R2 did not store extraction manifest for document ${jobId} at ${manifestKey}`)

        message.ack()
        console.log(JSON.stringify({
          event: 'document_extracted',
          inputBytes: sourceDocument.size,
          jobId,
          milliseconds: Date.now() - startedAt,
          outputBytes,
          totalPages,
        }))
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(JSON.stringify({
          event: 'document_extraction_failed',
          attempt: message.attempts,
          jobId,
          reason,
        }))
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<Env, ExtractionJob>
