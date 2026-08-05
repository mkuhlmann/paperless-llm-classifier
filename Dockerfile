FROM oven/bun:1.3.9 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY . .

RUN bun build src/index.ts --target=bun --outfile dist/index.js

FROM oven/bun:1.3.9 AS runtime
WORKDIR /app

# poppler-utils provides pdftoppm, used to rasterize PDF pages for vision-mode OCR+metadata extraction.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist/index.js ./index.js

ENV NODE_ENV=production

CMD ["bun", "index.js"]
