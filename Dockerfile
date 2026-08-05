FROM oven/bun:1.3.9-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY . .

RUN bun build src/index.ts --target=bun --outfile dist/index.js

FROM oven/bun:1.3.9-alpine AS runtime
WORKDIR /app

# poppler-utils provides pdftoppm, used to rasterize PDF pages for vision-mode OCR+metadata extraction.
# font-dejavu is a substitute for the standard PDF fonts (Helvetica, Times, Courier) that born-digital
# PDFs reference without embedding — without it, pdftoppm silently drops that text when rasterizing
# (Alpine's poppler-utils doesn't pull in a default font the way Debian's does).
RUN apk add --no-cache poppler-utils font-dejavu

COPY --from=builder /app/dist/index.js ./index.js

ENV NODE_ENV=production

CMD ["bun", "index.js"]
