import { config } from './config';
import { logger } from './log';

export class DoclingClient {
	async processFile(fileBuffer: Buffer, filename: string): Promise<string> {
		if (!config.DOCLING_URL) {
			throw new Error('DOCLING_URL is not configured.');
		}
		const url = config.DOCLING_URL + '/v1/convert/source';

		logger.info(`Sending ${filename} to Docling for OCR...`);
		const base64Data = fileBuffer.toString('base64');

		const payload = {
			options: {
				to_formats: ['md'],
				do_ocr: true,
				image_export_mode: 'placeholder',
				ocr_engine: 'rapidocr',
			},
			sources: [
				{
					filename,
					base64_string: base64Data,
					kind: 'file',
				},
			],
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(720000), // 12 minutes timeout
			// @ts-ignore bun internal
			timeout: false,
			verbose: true,
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger
				.withMetadata({ error: errorText })
				.error(`Docling processing failed: ${response.status} ${response.statusText}`);
			throw new Error(`Docling API error: ${response.status}`);
		}

		const data: any = await response.json();

		if (data.status !== 'success' || !data.document || !data.document.md_content) {
			throw new Error(`Docling processing failed or returned no text. Status: ${data.status}`);
		}

		return data.document.md_content;
	}
}

export const docling = new DoclingClient();
