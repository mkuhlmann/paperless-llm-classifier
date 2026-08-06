# paperless-llm-classifier

AI-powered document processing for [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx).

Tag a document, and a background worker reads it with an LLM and writes back a title,
correspondent, date, document type, tags, and custom fields — plus the document's text content if
it needed OCR.

## How it works

A worker polls Paperless-ngx every few seconds for tagged documents and runs each one through:

```
                    tag a document in Paperless-ngx
                                 │
                                 ▼
                       needs OCR? (a scan)
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                   no                        yes
                    │              ┌──────────┴──────────┐
                    │              │                     │
                    │         VISION LLM ★             DOCLING
                    │        (default)               (optional fallback)
                    │        one call: image        image → markdown text,
                    │        → text + metadata      then a 2nd LLM call
                    │              │                extracts metadata
                    │              │                     │
                    └──────────────┴──────────┬──────────┘
                                               ▼
                 title · correspondent · date · document type
                    tags · custom fields → written to Paperless-ngx
```

- **Vision mode** (default, recommended) — the LLM sees rasterized page images and returns OCR text
  *and* metadata in a single call. Needs a vision-capable model.
- **Docling** — an optional fallback for when you don't have a vision model. It OCRs the document
  to Markdown first, then a separate (text-only) LLM call extracts metadata from that text.
- **Born-digital PDFs** skip OCR entirely — their own embedded text is used directly.

## Quick start

Requirements: [Bun](https://bun.sh), a reachable Paperless-ngx instance, and an OpenAI-compatible
LLM endpoint (OpenAI, Gemini's OpenAI-compatible endpoint, OpenRouter, a local Ollama/vLLM server,
etc.).

1. Install dependencies:

   ```bash
   bun install
   ```

2. Copy `.env.example` to `.env` and fill in `PAPERLESS_URL`, `PAPERLESS_TOKEN`, and your LLM
   provider (see [Configuration](#configuration)).

3. Run it:

   ```bash
   bun dev
   ```

### Docker

Prebuilt multi-arch images (`linux/amd64`, `linux/arm64`) are published to GitHub Container Registry
on every push to `main` and on version tags — see
[`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml).

```bash
docker run --env-file .env ghcr.io/mkuhlmann/paperless-llm-classifier:latest
```

Or build locally:

```bash
docker build -t paperless-llm-classifier .
docker run --env-file .env paperless-llm-classifier
```

The image installs `poppler-utils`, so vision mode works out of the box.

## Configuration

All values are read from `.env`, validated against the Zod schema in `src/config.ts`. See
[`.env.example`](.env.example) for a ready-to-copy template.

### Connection

| Variable          | Description                            | Default                 |
| ------------------ | --------------------------------------- | ------------------------- |
| `PAPERLESS_URL`    | Base URL of your Paperless-ngx instance | Required                 |
| `PAPERLESS_TOKEN`  | API token for Paperless-ngx             | Required                 |

### LLM

The primary endpoint is tried first for every request. The secondary is only used as a fallback
when a call to the primary endpoint fails.

| Variable                              | Description                                                        | Default  |
| --------------------------------------- | ---------------------------------------------------------------------- | ---------- |
| `OPENAI_COMPATIBLE_API_URL`            | Base URL of the primary OpenAI-compatible API                        | Required |
| `OPENAI_COMPATIBLE_API_KEY`            | API key for the primary endpoint (omit if the endpoint needs none)   | Optional |
| `OPENAI_COMPATIBLE_MODEL`              | Model name for the primary endpoint                                  | Required |
| `OPENAI_COMPATIBLE_VISION`             | Whether the primary model supports image input — enables [vision mode](#how-it-works) | `false`  |
| `OPENAI_COMPATIBLE_SECONDARY_API_URL`  | Base URL of the secondary (fallback) endpoint                        | Optional |
| `OPENAI_COMPATIBLE_SECONDARY_API_KEY`  | API key for the secondary endpoint                                   | Optional |
| `OPENAI_COMPATIBLE_SECONDARY_MODEL`    | Model name for the secondary endpoint (required if the URL is set)   | Optional |
| `OPENAI_COMPATIBLE_SECONDARY_VISION`   | Whether the secondary model supports image input                     | `false`  |
| `LLM_ANSWER_LANGUAGE`                  | Language hint for LLM extraction                                     | `English` |
| `OWN_NAME`                             | Your name, to avoid it leaking into generated titles                 | Optional |

### OCR

| Variable                  | Description                                                                     | Default |
| -------------------------- | --------------------------------------------------------------------------------- | ------- |
| `DOCLING_URL`              | Base URL of [Docling](https://github.com/DS4SD/docling) — only needed as an OCR fallback when vision mode is off | Optional |
| `OCR_MODE`                 | `auto`, `force`, or `skip` — see [OCR modes](#ocr-modes)                          | `auto`  |
| `OCR_MIN_CHARS_PER_PAGE`   | Visible characters per page above which a PDF counts as born-digital (`auto` mode) | `100`   |

### Tags

| Variable            | Description                                                    | Default          |
| -------------------- | ------------------------------------------------------------------ | ---------------- |
| `TAG_AI_AUTO`        | Trigger tag for metadata extraction                                | `ai-auto`        |
| `TAG_AI_OCR_AUTO`    | Trigger tag for OCR                                                | `ai-ocr-auto`    |
| `TAG_AI_OCR_DONE`    | Added once OCR (or its born-digital equivalent) has run            | `ai-ocr-done`    |
| `TAG_AI_DONE`        | Optional tag added after a successful `ai-auto` metadata pass      | Optional         |
| `TAG_AI_FAILED`      | Added when processing fails                                        | `ai-failed`      |

### Behavior

| Variable                     | Description                                              | Default |
| ------------------------------ | ------------------------------------------------------------ | ------- |
| `POLL_INTERVAL_MS`             | Poll interval in milliseconds                               | `10000` |
| `ALLOW_NEW_CORRESPONDENT`      | Allow creating new correspondents from LLM suggestions       | `false` |

## OCR modes

`OCR_MODE` controls whether a document's text comes from OCR (vision or Docling) or from the PDF
itself, mirroring [Paperless-ngx's own `PAPERLESS_OCR_MODE`](https://docs.paperless-ngx.com/configuration/#PAPERLESS_OCR_MODE)
(minus `redo`, which doesn't apply — this tool never rewrites the source PDF).

| Mode    | Behavior                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------ |
| `auto`  | (default) Inspect each PDF's text layer. Born-digital PDFs use their own embedded text — no OCR call. Scanned PDFs (and all non-PDF documents) still go through OCR. |
| `force` | Always OCR, regardless of document content.                                                      |
| `skip`  | Never OCR. PDFs use whatever text is already embedded in them (including an existing OCR layer); non-PDF documents get no text at all. |

<details>
<summary>Why "does it have text?" isn't the right check</summary>

Paperless-ngx itself runs OCRmyPDF over everything it consumes (its own `PAPERLESS_OCR_MODE`
defaults to `auto`), so by the time a document reaches this tool, **both** a born-digital PDF and a
scanned one typically already have a text layer. A plain "does this PDF have text?" check can't tell
them apart — it would treat every scan as born-digital and never OCR anything.

The actual discriminator is *how* the text is drawn. OCRmyPDF's "sandwich" renderer draws its
Tesseract output as **invisible text** (PDF text rendering mode 3) on top of the page image;
born-digital text is drawn visibly. `auto` mode reads that distinction directly from the PDF's
content stream (via [unpdf](https://github.com/unjs/unpdf)) and classifies a PDF as born-digital
only when it has at least `OCR_MIN_CHARS_PER_PAGE` *visible* characters per page. If PDF analysis
itself fails (corrupt/encrypted file), `auto` falls back to running OCR rather than risking silently
empty content.

</details>

## Reference

### Tag flow

- Documents with `TAG_AI_OCR_AUTO` run OCR (or its `auto`/`skip`-mode equivalent) first.
- Documents with `TAG_AI_AUTO` run LLM metadata extraction.
- If both tags are present, OCR (or the embedded-text/skip equivalent) runs before metadata
  extraction — in vision mode, both happen in a single call.
- Trigger tags (`ai-auto`, `ai-ocr-auto`) are removed once metadata patching succeeds.
- A literal tag named `inbox` is preserved through processing — it's the one exception to "existing
  tags not explicitly kept are dropped" during the final tag-list rebuild.
- `TAG_AI_OCR_DONE` is applied whenever OCR (or the embedded-text equivalent) actually produced
  text; it is **not** applied when `OCR_MODE=skip` runs against a non-PDF document, since no text
  was produced.
- If `TAG_AI_DONE` is configured, it's applied after a successful metadata pass.
- On failure, both trigger tags are removed and `TAG_AI_FAILED` is added.

### Correspondent & document type behavior

- The LLM can always suggest a correspondent name.
- If the suggested correspondent already exists in Paperless, it's used.
- If it doesn't exist:
  - With `ALLOW_NEW_CORRESPONDENT=false` (default): the correspondent is left unset.
  - With `ALLOW_NEW_CORRESPONDENT=true`: a new correspondent is created and assigned.
- Document types are handled differently: the LLM is only allowed to pick from your **existing**
  document types. Unlike correspondents, a new document type is never created automatically —
  there's no `ALLOW_NEW_DOCUMENT_TYPE` equivalent.

### Manual processing

Process one document ID on demand — bypasses the poll loop and tag lookups happen fresh:

```bash
bun run src/index.ts process <document_id>
```

## Troubleshooting

- **`pdftoppm failed ... Is poppler-utils installed?`** — vision mode needs `poppler-utils` on the
  host (or in the container; the provided `Dockerfile` already installs it). Install it or leave
  `OPENAI_COMPATIBLE_VISION` unset.
- **`needs OCR, but no OCR route is available`** — a scanned document needs OCR, but
  `OPENAI_COMPATIBLE_VISION` is off and `DOCLING_URL` is unset. Enable one of the two.
- **Docling errors / unreachable** — only matters when Docling actually runs (vision mode off, and
  `OCR_MODE=force`, or `auto` mode's fallback for a scanned document). Check `DOCLING_URL` and that
  the service is up.
- **Primary LLM requests silently falling back to the secondary** — check the logs for a `Provider
  primary (<model>) failed, trying secondary...` warning; the primary call errored and the request
  was retried on the secondary endpoint.
- **Inspecting what was actually sent to the LLM** — every request overwrites
  `logs/last_prompt.txt` with the exact system + user prompt used for that call.
- **A born-digital PDF isn't being detected** — check the info-level log line for that document
  (`Born-digital PDF detected (N visible chars/page ...)` vs `PDF needs OCR (...)`). If a text-light
  document is landing on the wrong side of the threshold, adjust `OCR_MIN_CHARS_PER_PAGE`.

## License

[MIT](LICENSE)
