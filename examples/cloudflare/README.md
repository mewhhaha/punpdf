# Cloudflare Workers example

This Worker streams PDF uploads into R2, queues extraction work, and writes visual-order text back to R2 one page at a time. It accepts PDFs up to 16 MiB.

Create the production resources once:

```bash
pnpm exec wrangler r2 bucket create punpdf-documents
pnpm exec wrangler queues create punpdf-extraction
pnpm exec wrangler queues create punpdf-extraction-dead-letter
```

Generate binding types and start the local Worker:

```bash
pnpm install
pnpm types
pnpm dev
```

Local R2 and Queue bindings are simulated by Wrangler. Submit a document and poll the returned result URL:

```bash
curl --request POST \
  --header 'Content-Type: application/pdf' \
  --data-binary @document.pdf \
  http://localhost:8787/documents

curl http://localhost:8787/documents/<job-id>
```

The first request returns `202 Accepted`. The result endpoint returns `202` while extraction is in progress and streams the completed text with `200 OK` afterward. Failed Queue messages retry three times before moving to `punpdf-extraction-dead-letter`.
