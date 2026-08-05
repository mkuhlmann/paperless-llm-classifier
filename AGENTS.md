# Agent Guide - paperless-llm-classifier

This document provides instructions and guidelines for agentic coding agents operating in this repository.

## Commands

This project uses [Bun](https://bun.sh) as its runtime and package manager.

- **Install dependencies:** `bun install`
- **Run in development (watch mode):** `bun dev`
- **Run the main application:** `bun run src/index.ts`
- **Manual document processing:** `bun run src/index.ts process <document_id>`
- **Run tests:** `bun test` (Note: No tests currently exist; add them to `src/*.test.ts`)
- **Type check:** `bun x tsc --noEmit`

## Project Architecture

- `src/index.ts`: Entry point. Manages the polling loop and command-line arguments.
- `src/paperless.ts`: `PaperlessClient` class for interacting with the Paperless-ngx API.
- `src/processor.ts`: Core logic for processing documents (OCR, AI metadata extraction).
- `src/llm.ts`: Integration with Vercel AI SDK (Gemini/OpenAI compatible).
- `src/docling.ts`: Integration with Docling service for document parsing.
- `src/config.ts`: Environment variable configuration and validation using Zod.
- `src/log.ts`: Logging configuration using `loglayer` and `consola`.

## Code Style & Guidelines

### TypeScript & Bun
- Use **TypeScript** for all new files.
- Prefer **Bun** APIs (e.g., `Bun.file`, `Bun.password`) where appropriate, but stick to standard Node/Web APIs if portability is preferred.
- Use ES Modules (import/export).

### Formatting
- **Indentation:** Use **Tabs**.
- **Quotes:** Use **Single Quotes** for strings.
- **Semicolons:** Always use semicolons.
- **Trailing Commas:** Use trailing commas in multi-line objects and arrays.

### Naming Conventions
- **Classes/Interfaces/Types:** `PascalCase`.
- **Variables/Functions:** `camelCase`.
- **Constants/Env Vars:** `SCREAMING_SNAKE_CASE`.
- **Files:** `kebab-case.ts` (though existing files use `camelCase.ts` or `snake_case.ts` - follow the specific directory's pattern). *Correction: Current files use `camelCase.ts` (e.g., `processDocument` -> `processor.ts`). Actually, they are single words or `camelCase`.*

### Types & Validation
- Define interfaces for all API responses and complex data structures in `src/paperless.ts` or relevant files.
- Use **Zod** for any external data validation (API responses, environment variables, user input).
- Avoid `any`. Use `unknown` if the type is truly unknown and narrow it down.

### Error Handling & Logging
- Use `try-catch` blocks for all asynchronous operations and API calls.
- Use the central `logger` from `src/log.ts`.
- **Do not use `console.log`**.
- Pattern for logging errors: `logger.withError(err).error('Descriptive message');`.
- Pattern for logging metadata: `logger.withMetadata({ key: value }).info('Message');`.

### API Interactions
- All Paperless-ngx interactions should be added to the `PaperlessClient` in `src/paperless.ts`.
- Use the `config` object from `src/config.ts` for all configuration.

### AI Integration
- Use the **Vercel AI SDK** (`ai` package).
- Support both Google (Gemini) and OpenAI-compatible providers as configured in `src/llm.ts`.
- When extracting structured data, use `generateObject` with Zod schemas.
