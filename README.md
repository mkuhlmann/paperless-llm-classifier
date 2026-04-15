# paperless-ai

AI-powered document processing for [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx).

The service polls Paperless for documents tagged for automation and runs:

1. OCR via Docling.
2. Metadata extraction via LLM.
3. Metadata/tag/custom-field patching back to Paperless.

## Features

- OCR pipeline using [Docling](https://github.com/DS4SD/docling) (Markdown output).
- Metadata extraction for title, correspondent, created date, document type, tags, and custom fields.
- Supports Gemini or an OpenAI-compatible endpoint.
- Sequential polling loop (no overlapping processing cycles).
- Automatic management of trigger/result/failure tags.

## Requirements

- Bun runtime.
- Reachable Paperless-ngx API.
- Reachable Docling service.
- LLM credentials (Gemini by default, optional OpenAI-compatible provider).

## Setup

1. Install dependencies.

```bash
bun install
```

2. Create a `.env` file (see Configuration).

3. Start in watch mode.

```bash
bun dev
```

## Configuration

All values are read from `.env`.

| Variable                       | Description                                                 | Default                  |
| ------------------------------ | ----------------------------------------------------------- | ------------------------ |
| `PAPERLESS_URL`                | Base URL of your Paperless-ngx instance                     | Required                 |
| `PAPERLESS_TOKEN`              | API token for Paperless-ngx                                 | Required                 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API key                                              | Required                 |
| `DOCLING_URL`                  | Base URL of Docling                                         | `http://localhost:50000` |
| `AI_MODEL`                     | Preferred AI model name                                     | `gemini-2.5-flash`       |
| `POLL_INTERVAL_MS`             | Poll interval in milliseconds                               | `10000`                  |
| `TAG_AI_AUTO`                  | Trigger tag for metadata extraction                         | `ai-auto`                |
| `TAG_AI_OCR_AUTO`              | Trigger tag for OCR                                         | `ai-ocr-auto`            |
| `TAG_AI_OCR_DONE`              | Added after OCR succeeds                                    | `ai-ocr-done`            |
| `TAG_AI_DONE`                  | Optional tag added after successful `ai-auto` metadata flow | Optional                 |
| `TAG_AI_FAILED`                | Added when processing fails                                 | `ai-failed`              |
| `ALLOW_NEW_CORRESPONDENT`      | Allow creating new correspondents from LLM suggestions      | `false`                  |
| `LLM_ANSWER_LANGUAGE`          | Main language hint for LLM extraction                       | `English`                |
| `OWN_NAME`                     | Name to avoid in generated titles                           | Optional                 |
| `OPENAI_COMPATIBLE_API_URL`    | OpenAI-compatible API base URL (if used)                    | Optional                 |
| `OPENAI_COMPATIBLE_API_KEY`    | API key for compatible endpoint                             | Optional                 |
| `OPENAI_COMPATIBLE_MODEL`      | Model for compatible endpoint                               | Optional                 |

## Tag Flow

- Documents with `TAG_AI_OCR_AUTO` run OCR first.
- Documents with `TAG_AI_AUTO` run LLM metadata extraction.
- If both tags are present, OCR runs before metadata extraction.
- Trigger tags are removed during successful metadata patching.
- `TAG_AI_OCR_DONE` is kept when OCR was performed.
- If `TAG_AI_DONE` is configured, it is ensured and applied after successful metadata processing.
- On failure, trigger tags are removed and `TAG_AI_FAILED` is added.

## Correspondent Behavior

- The LLM can always suggest a correspondent name.
- If the suggested correspondent already exists in Paperless, it is used.
- If it does not exist:
  - With `ALLOW_NEW_CORRESPONDENT=false` (default): correspondent is set to `null`.
  - With `ALLOW_NEW_CORRESPONDENT=true`: a new correspondent is created and assigned.

## Usage

### Automatic mode

Run the polling worker:

```bash
bun dev
```

### Manual mode

Process one document ID on demand:

```bash
bun run src/index.ts process <document_id>
```
