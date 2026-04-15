import { config } from './config';
import { logger } from './log';
import { paperless } from './paperless';
import type { Tag } from './paperless';
import { processDocument } from './processor';

async function main() {
	const args = process.argv.slice(2);
	if (args.length > 0 && args[0] === 'process' && args[1]) {
		const docId = parseInt(args[1], 10);
		if (isNaN(docId)) {
			logger.error(`Invalid document ID: ${args[1]}`);
			process.exit(1);
		}
		logger.info(`Manually processing Document #${docId}...`);
		try {
			await processDocument(docId);
			logger.info(`Manual processing of Document #${docId} complete.`);
			process.exit(0);
		} catch (err) {
			logger.withError(err as Error).error(`Failed to manually process Document #${docId}`);
			process.exit(1);
		}
	}

	logger.info(`Starting Paperless AI Processor...`);
	logger.info(
		`Polling every ${config.POLL_INTERVAL_MS}ms for tags: '${config.TAG_AI_AUTO}' or '${config.TAG_AI_OCR_AUTO}'`,
	);

	// Fast mapping structures
	let tagAiAuto = await paperless.ensureTag(config.TAG_AI_AUTO);
	let tagAiOcrAuto = await paperless.ensureTag(config.TAG_AI_OCR_AUTO);
	let tagAiOcrDone = await paperless.ensureTag(config.TAG_AI_OCR_DONE);
	let tagAiDone: Tag | undefined = config.TAG_AI_DONE ? await paperless.ensureTag(config.TAG_AI_DONE) : undefined;
	let tagAiFailed = await paperless.ensureTag(config.TAG_AI_FAILED);

	async function refreshTags() {
		tagAiAuto = await paperless.ensureTag(config.TAG_AI_AUTO);
		tagAiOcrAuto = await paperless.ensureTag(config.TAG_AI_OCR_AUTO);
		tagAiOcrDone = await paperless.ensureTag(config.TAG_AI_OCR_DONE);
		tagAiDone = config.TAG_AI_DONE ? await paperless.ensureTag(config.TAG_AI_DONE) : undefined;
		tagAiFailed = await paperless.ensureTag(config.TAG_AI_FAILED);
	}

	// Set up sequential processing loop instead of overlapping intervals
	async function poll() {
		try {
			await refreshTags();

			// Get documents carrying either tag
			const docsObj = await paperless.getDocumentsByTagParams(`${tagAiAuto.id},${tagAiOcrAuto.id}`);
			const docs = docsObj.results;

			if (docs.length > 0) {
				logger.info(`Found ${docs.length} document(s) tagged for processing.`);

				for (const doc of docs) {
					await processDocument(doc.id, {
						tagAiAuto,
						tagAiOcrAuto,
						tagAiOcrDone,
						tagAiDone,
						tagAiFailed,
					});
				}
			}
		} catch (pollingErr) {
			logger.withError(pollingErr as Error).error('Error connecting to Paperless');
		} finally {
			// Re-trigger timeout
			setTimeout(poll, config.POLL_INTERVAL_MS);
		}
	}

	// Start polling
	setTimeout(poll, 0); // start immediately
}

main().catch((err) => {
	logger.withError(err).error('Fatal Application Error');
	process.exit(1);
});
