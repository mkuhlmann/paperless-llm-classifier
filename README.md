# paperless-llm-classifier

AI-powered document processing for [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx).

A polling worker watches your Paperless-ngx instance for documents carrying trigger tags and runs:

1. **OCR** — via [Docling](https://github.com/DS4SD/docling), or skipped entirely for born-digital PDFs (see [OCR modes](#ocr-modes)).
2. **Metadata extraction** — title, correspondent, date, document type, tags, and custom fields, via an LLM (Gemini or an OpenAI-compatible endpoint).
3. **Patch-back** — the results are written to Paperless as tags, metadata, and (for OCR) document content.

## Features

- Three ways to get document text into an LLM prompt, chosen automatically per document:
  - **Docling OCR** (Markdown output) for scanned documents.
  - **Embedded PDF text** for born-digital PDFs — no OCR call at all (see [OCR modes](#ocr-modes)).
  - **Vision mode** — an OpenAI-compatible vision model performs OCR and metadata extraction in a single call, from rasterized page images.
- Metadata extraction for title, correspondent, created date, document type, tags, and custom fields.
- Supports Gemini or an OpenAI-compatible endpoint (with automatic fallback to Gemini if the latter is unreachable).
- Sequential polling loop (no overlapping processing cycles).
- Automatic management of trigger/result/failure tags.

## Requirements

- Bun runtime.
- Reachable Paperless-ngx API.
- Reachable Docling service — only actually contacted when OCR runs (see [OCR modes](#ocr-modes)); a document that turns out to be born-digital, or that's processed under `OCR_MODE=skip`, never calls it.
- LLM credentials: a Gemini API key is always required; an OpenAI-compatible endpoint is optional and tried first when configured.
- `poppler-utils` (`pdftoppm`) — only if you use [vision mode](#openai_compatible_vision), to rasterize PDF pages into images. Not needed otherwise.

## Setup

1. Install dependencies.

```bash
bun install
```

2. Create a `.env` file (see [Configuration](#configuration)).

3. Start in watch mode.

```bash
bun dev
```

### Docker

Prebuilt multi-arch images (`linux/amd64`, `linux/arm64`) are published to GitHub Container Registry on every push to `main` and on version tags — see [`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml).

```bash
docker run --env-file .env ghcr.io/mkuhlmann/paperless-llm-classifier:latest
```

Or build locally:

```bash
docker build -t paperless-llm-classifier .
docker run --env-file .env paperless-llm-classifier
```

The image installs `poppler-utils` in the runtime stage, so vision mode works out of the box.

## Configuration

All values are read from `.env`, validated against the Zod schema in `src/config.ts`.

### Connection

| Variable           | Description                              | Default                   |
| ------------------ | ----------------------------------------- | -------------------------- |
| `PAPERLESS_URL`     | Base URL of your Paperless-ngx instance   | Required                   |
| `PAPERLESS_TOKEN`   | API token for Paperless-ngx               | Required                   |
| `DOCLING_URL`       | Base URL of Docling                       | `http://localhost:50000`   |

### LLM

| Variable                        | Description                                                                                  | Default             |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| `GOOGLE_GENERATIVE_AI_API_KEY`   | Gemini API key                                                                                 | Required             |
| `GOOGLE_AI_MODEL`                | Gemini model — used as the primary model, or as fallback when the OpenAI-compatible endpoint is unset or unreachable | `gemini-2.5-flash`   |
| `OPENAI_COMPATIBLE_API_URL`      | OpenAI-compatible API base URL. If set, it's tried first (a `GET {url}/models` reachability check, 3s timeout); Gemini is used otherwise | Optional             |
| `OPENAI_COMPATIBLE_API_KEY`      | API key for the OpenAI-compatible endpoint                                                    | Optional             |
| `OPENAI_COMPATIBLE_MODEL`        | Model name for the OpenAI-compatible endpoint                                                 | Optional             |
| `OPENAI_COMPATIBLE_VISION`       | Whether that model supports vision/image input — enables [vision mode](#openai_compatible_vision) | `false`          |
| `LLM_ANSWER_LANGUAGE`            | Language hint for LLM extraction                                                              | `English`             |
| `OWN_NAME`                       | Your name, to avoid it leaking into generated titles                                          | Optional             |

### OCR

| Variable                  | Description                                                                     | Default |
| -------------------------- | --------------------------------------------------------------------------------- | ------- |
| `OCR_MODE`                 | `auto`, `force`, or `skip` — see [OCR modes](#ocr-modes)                          | `auto`  |
| `OCR_MIN_CHARS_PER_PAGE`   | Visible characters per page above which a PDF counts as born-digital (`auto` mode) | `100`   |

### Tags

| Variable            | Description                                                    | Default          |
| -------------------- | ------------------------------------------------------------------ | ---------------- |
| `TAG_AI_AUTO`        | Trigger tag for metadata extraction                                | `ai-auto`        |
| `TAG_AI_OCR_AUTO`    | Trigger tag for OCR                                                | `ai-ocr-auto`    |
| `TAG_AI_OCR_DONE`    | Added once OCR (or its born-digital/skip-mode equivalent) has run  | `ai-ocr-done`    |
| `TAG_AI_DONE`        | Optional tag added after a successful `ai-auto` metadata pass      | Optional         |
| `TAG_AI_FAILED`      | Added when processing fails                                        | `ai-failed`      |

### Behavior

| Variable                     | Description                                              | Default |
| ------------------------------ | ------------------------------------------------------------ | ------- |
| `POLL_INTERVAL_MS`             | Poll interval in milliseconds                               | `10000` |
| `ALLOW_NEW_CORRESPONDENT`      | Allow creating new correspondents from LLM suggestions       | `false` |

## How processing works

```
processDocument(doc)
│
├─ hasOcrAuto = doc has 'ai-ocr-auto'
├─ hasAiAuto  = doc has 'ai-auto'
│
├─ if hasOcrAuto: ocrPlan = planOcr(doc)   ← decided by OCR_MODE, see below
│  else:          ocrPlan = 'none' (OCR wasn't requested at all)
│
├─ if hasOcrAuto && hasAiAuto && OPENAI_COMPATIBLE_VISION && ocrPlan == 'ocr':
│  │
│  └─ VISION PATH — rasterize PDF/image pages (pdftoppm), one LLM call
│     returns OCR text + metadata together, both written to Paperless
│
└─ else: STANDARD PATH — handles all three ocrPlan outcomes:
   │
   ├─ ocrPlan == 'embedded'  →  use the PDF's own text as-is, no OCR call
   ├─ ocrPlan == 'ocr'       →  Docling OCR → Markdown
   ├─ ocrPlan == 'none'      →  OCR_MODE=skip on a non-PDF: no text produced
   │
   └─ then, if hasAiAuto:
        llm.extractMetadata(text) → applyExtractedMetadata()
        → tags / correspondent / document type / custom fields
          patched back to Paperless
```

Each poll cycle fetches up to **10 documents** at a time (Paperless-ngx's default page size) carrying either trigger tag, and processes them one at a time — not concurrently.

## OCR modes

`OCR_MODE` controls whether a document's text comes from OCR or from the PDF itself, mirroring [Paperless-ngx's own `PAPERLESS_OCR_MODE`](https://docs.paperless-ngx.com/configuration/#PAPERLESS_OCR_MODE) (minus `redo`, which doesn't apply — this tool never rewrites the source PDF).

| Mode    | Behavior                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------ |
| `auto`  | (default) Inspect each PDF's text layer. Born-digital PDFs use their own embedded text — no OCR call. Scanned PDFs (and all non-PDF documents) still go through OCR. |
| `force` | Always OCR, exactly as before this feature existed.                                              |
| `skip`  | Never OCR. PDFs use whatever text is already embedded in them (including an existing OCR layer); non-PDF documents get no text at all. |

### Why "does it have text?" isn't the right check

Paperless-ngx itself runs OCRmyPDF over everything it consumes (its own `PAPERLESS_OCR_MODE` defaults to `auto`), so by the time a document reaches this tool, **both** a born-digital PDF and a scanned one typically already have a text layer. A plain "does this PDF have text?" check can't tell them apart — it would treat every scan as born-digital and never OCR anything.

The actual discriminator is *how* the text is drawn. OCRmyPDF's "sandwich" renderer draws its Tesseract output as **invisible text** (PDF text rendering mode 3) on top of the page image; born-digital text is drawn visibly. `auto` mode reads that distinction directly from the PDF's content stream (via [unpdf](https://github.com/unjs/unpdf)) and classifies a PDF as born-digital only when it has at least `OCR_MIN_CHARS_PER_PAGE` *visible* characters per page. If PDF analysis itself fails (corrupt/encrypted file), `auto` falls back to running OCR rather than risking silently empty content.

## Tag flow

- Documents with `TAG_AI_OCR_AUTO` run OCR (or its `auto`/`skip`-mode equivalent) first.
- Documents with `TAG_AI_AUTO` run LLM metadata extraction.
- If both tags are present, OCR (or the embedded-text/skip equivalent) runs before metadata extraction.
- Trigger tags (`ai-auto`, `ai-ocr-auto`) are removed once metadata patching succeeds.
- A literal tag named `inbox` is preserved through processing — it's the one exception to "existing tags not explicitly kept are dropped" during the final tag-list rebuild.
- `TAG_AI_OCR_DONE` is applied whenever OCR (or the embedded-text equivalent) actually produced text; it is **not** applied when `OCR_MODE=skip` runs against a non-PDF document, since no text was produced.
- If `TAG_AI_DONE` is configured, it's applied after a successful metadata pass.
- On failure, both trigger tags are removed and `TAG_AI_FAILED` is added.

## Correspondent & document type behavior

- The LLM can always suggest a correspondent name.
- If the suggested correspondent already exists in Paperless, it's used.
- If it doesn't exist:
  - With `ALLOW_NEW_CORRESPONDENT=false` (default): the correspondent is left unset.
  - With `ALLOW_NEW_CORRESPONDENT=true`: a new correspondent is created and assigned.
- Document types are handled differently: the LLM is only allowed to pick from your **existing** document types. Unlike correspondents, a new document type is never created automatically — there's no `ALLOW_NEW_DOCUMENT_TYPE` equivalent.

## Usage

### Automatic mode

Run the polling worker:

```bash
bun dev
```

### Manual mode

Process one document ID on demand — bypasses the poll loop and tag lookups happen fresh:

```bash
bun run src/index.ts process <document_id>
```

## Troubleshooting

- **`pdftoppm failed ... Is poppler-utils installed?`** — vision mode needs `poppler-utils` on the host (or in the container; the provided `Dockerfile` already installs it). Install it or leave `OPENAI_COMPATIBLE_VISION` unset.
- **Docling errors / unreachable** — only matters when OCR actually runs (`OCR_MODE=force`, or `auto` mode's fallback for a scanned document). Check `DOCLING_URL` and that the service is up.
- **OpenAI-compatible requests silently going to Gemini** — the `/models` reachability probe (3s timeout) failed; check the logs for a `"Llama inference not reachable, falling back to Gemini"` warning.
- **Inspecting what was actually sent to the LLM** — every request overwrites `logs/last_prompt.txt` with the exact system + user prompt used for that call.
- **A born-digital PDF isn't being detected** — check the info-level log line for that document (`Born-digital PDF detected (N visible chars/page ...)` vs `PDF needs OCR (...)`). If a text-light document is landing on the wrong side of the threshold, adjust `OCR_MIN_CHARS_PER_PAGE`.

## License

[MIT](LICENSE)
