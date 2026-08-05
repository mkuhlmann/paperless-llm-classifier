import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { rm, mkdir } from 'fs/promises';
import { config } from './config';
import { logger } from './log';
import { paperless } from './paperless';
import type { Tag, Document, Correspondent, DocumentType, CustomField } from './paperless';
import { docling } from './docling';
import { llm } from './llm';
import type { ExtractedMetadata } from './llm';
import { analyzePdfText, extractPdfText } from './pdf';

async function pdfToImages(pdfBuffer: Buffer): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
	const tmpDir = join(tmpdir(), `paperless-ai-${randomBytes(8).toString('hex')}`);
	const pdfPath = join(tmpDir, 'document.pdf');

	try {
		await mkdir(tmpDir, { recursive: true });
		await Bun.write(pdfPath, pdfBuffer);

		const proc = Bun.spawn(['pdftoppm', '-png', '-r', '150', pdfPath, join(tmpDir, 'page')], {
			stdout: 'ignore',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`pdftoppm failed (exit ${exitCode}): ${stderr.trim()}. Is poppler-utils installed? (apt install poppler-utils)`);
		}

		const glob = new Bun.Glob('page-*.png');
		const filenames: string[] = [];
		for await (const f of glob.scan(tmpDir)) {
			filenames.push(f);
		}
		filenames.sort();

		const images: Array<{ buffer: Buffer; mimeType: string }> = [];
		for (const filename of filenames) {
			const arrayBuffer = await Bun.file(join(tmpDir, filename)).arrayBuffer();
			images.push({ buffer: Buffer.from(arrayBuffer), mimeType: 'image/png' });
		}

		return images;
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

async function getDocumentImages(
	doc: Document,
	preloadedBuffer?: Buffer,
): Promise<{ pages: Array<{ buffer: Buffer; mimeType: string }>; supported: boolean }> {
	if (doc.mime_type.startsWith('image/')) {
		const buffer = preloadedBuffer ?? (await paperless.downloadDocument(doc.id, true));
		return { pages: [{ buffer, mimeType: doc.mime_type }], supported: true };
	}
	if (doc.mime_type === 'application/pdf') {
		const pdfBuffer = preloadedBuffer ?? (await paperless.downloadDocument(doc.id, true));
		const pages = await pdfToImages(pdfBuffer);
		return { pages, supported: true };
	}
	return { pages: [], supported: false };
}

/**
 * Decides how (or whether) OCR should run for a document, based on `OCR_MODE`.
 *
 * `auto` and `skip` both need to inspect PDFs, so they download and analyze the file up front —
 * the resulting buffer is carried on the `'ocr'` result so callers don't download it a second time.
 * Non-PDF documents can't be born-digital-detected (there's no embedded text layer to inspect), so
 * `auto`/`force` always OCR them and `skip` always leaves them untouched.
 */
type OcrPlan =
	| { action: 'embedded'; text: string } // use the PDF's own text; no OCR needed
	| { action: 'ocr'; buffer?: Buffer } // real OCR needed (Docling or vision); buffer set if already downloaded
	| { action: 'none' }; // OCR_MODE=skip on a non-PDF: nothing to extract, nothing to OCR

async function planOcr(doc: Document): Promise<OcrPlan> {
	if (config.OCR_MODE === 'force') {
		return { action: 'ocr' };
	}

	const isPdf = doc.mime_type === 'application/pdf';

	if (config.OCR_MODE === 'skip') {
		if (!isPdf) {
			return { action: 'none' };
		}
		try {
			const buffer = await paperless.downloadDocument(doc.id, true);
			const text = await extractPdfText(buffer);
			return { action: 'embedded', text };
		} catch (err) {
			logger
				.withError(err as Error)
				.warn(`[Doc #${doc.id}] Failed to read embedded PDF text under OCR_MODE=skip; treating as empty.`);
			return { action: 'embedded', text: '' };
		}
	}

	// auto
	if (!isPdf) {
		return { action: 'ocr' };
	}
	try {
		const buffer = await paperless.downloadDocument(doc.id, true);
		const analysis = await analyzePdfText(buffer);
		if (analysis.visibleCharsPerPage >= config.OCR_MIN_CHARS_PER_PAGE) {
			logger.info(
				`[Doc #${doc.id}] Born-digital PDF detected (${Math.round(analysis.visibleCharsPerPage)} visible chars/page across ${analysis.pageCount} page(s)); skipping OCR.`,
			);
			const text = await extractPdfText(buffer);
			return { action: 'embedded', text };
		}
		logger.info(
			`[Doc #${doc.id}] PDF needs OCR (${Math.round(analysis.visibleCharsPerPage)} visible chars/page across ${analysis.pageCount} page(s)).`,
		);
		return { action: 'ocr', buffer };
	} catch (err) {
		logger.withError(err as Error).warn(`[Doc #${doc.id}] PDF text analysis failed; falling back to OCR.`);
		return { action: 'ocr' };
	}
}

async function applyExtractedMetadata(
	doc: Document,
	metadata: ExtractedMetadata,
	allTags: Tag[],
	allCorrs: Correspondent[],
	allTypes: DocumentType[],
	allFields: CustomField[],
	tagAiAuto: Tag,
	tagAiOcrAuto: Tag,
	tagAiOcrDone: Tag,
	tagAiDone: Tag | undefined,
	tagAiFailed: Tag,
	hasOcrAuto: boolean,
): Promise<void> {
	let correspondentId: number | null = null;
	if (metadata.correspondent) {
		const existingCorr = allCorrs.find((c) => c.name.toLowerCase() === metadata.correspondent?.toLowerCase());
		if (existingCorr) {
			correspondentId = existingCorr.id;
		} else if (config.ALLOW_NEW_CORRESPONDENT) {
			const corr = await paperless.createCorrespondent(metadata.correspondent);
			correspondentId = corr.id;
		} else {
			logger.info(
				`[Doc #${doc.id}] LLM suggested new correspondent '${metadata.correspondent}', but creation is disabled.`,
			);
		}
	}

	let documentTypeId: number | null = null;
	if (metadata.document_type) {
		const tId = allTypes.find((t) => t.name.toLowerCase() === metadata.document_type?.toLowerCase());
		if (tId) documentTypeId = tId.id;
	}

	// Important: We must remove processing tags here before calculating final patch tags
	let activeTagsIds = doc.tags.filter((t) => {
		const tag = allTags.find((tag) => tag.id === t);
		return (
			t === tagAiAuto.id ||
			t === tagAiOcrAuto.id ||
			t === tagAiOcrDone.id ||
			t === tagAiDone?.id ||
			t === tagAiFailed.id ||
			(tag && tag.name.toLowerCase() === 'inbox')
		);
	});
	// Now specifically filter out the trigger tags as we did before
	activeTagsIds = activeTagsIds.filter((t) => t !== tagAiAuto.id && t !== tagAiOcrAuto.id && t !== tagAiFailed.id);
	if (hasOcrAuto) {
		if (!activeTagsIds.includes(tagAiOcrDone.id)) {
			activeTagsIds.push(tagAiOcrDone.id);
		}
	}

	if (tagAiDone && !activeTagsIds.includes(tagAiDone.id)) {
		activeTagsIds.push(tagAiDone.id);
	}

	for (const tName of metadata.tags) {
		const tagMatch = allTags.find((t) => t.name.toLowerCase() === tName.toLowerCase());
		if (tagMatch && !activeTagsIds.includes(tagMatch.id)) {
			activeTagsIds.push(tagMatch.id);
		}
	}

	const customFieldsData: Array<{ field: number; value: any }> = [];
	for (const extractedField of metadata.custom_fields) {
		const match = allFields.find((f) => f.name.toLowerCase() === extractedField.field.toLowerCase());
		if (match) {
			customFieldsData.push({
				field: match.id,
				value: extractedField.value,
			});
		}
	}

	logger.info(`[Doc #${doc.id}] Applying new metadata and tags to Paperless...`);
	await paperless.setupDocumentMetadata(doc.id, {
		title: metadata.title,
		correspondentId: correspondentId,
		documentTypeId: documentTypeId,
		createdDate: metadata.created_date,
		tags: activeTagsIds,
		customFields: customFieldsData.length > 0 ? customFieldsData : undefined,
	});
}

/** Phase 2 (metadata extraction) shared by every OCR outcome: Docling, embedded PDF text, and no-OCR. */
async function runMetadataPhase(
	doc: Document,
	documentContent: string,
	tagAiAuto: Tag,
	tagAiOcrAuto: Tag,
	tagAiOcrDone: Tag,
	tagAiDone: Tag | undefined,
	tagAiFailed: Tag,
	hasOcrAuto: boolean,
): Promise<void> {
	if (!documentContent || documentContent.trim() === '') {
		logger.warn(`[Doc #${doc.id}] No text content for LLM processing. Falling back to using just the title.`);
		documentContent = doc.title;
	}

	logger.info(`[Doc #${doc.id}] Starting LLM analysis...`);

	const [allTags, allCorrs, allTypes, allFields] = await Promise.all([
		paperless.getTags(),
		paperless.getCorrespondents(),
		paperless.getDocumentTypes(),
		paperless.getCustomFields(),
	]);

	const aiTagIds = [tagAiAuto.id, tagAiOcrAuto.id, tagAiOcrDone.id, tagAiFailed.id];
	if (tagAiDone) aiTagIds.push(tagAiDone.id);
	const filteredTags = allTags.filter((t) => !aiTagIds.includes(t.id));

	const tagsNames = filteredTags.map((t) => t.name);
	const corrNames = allCorrs.map((c) => c.name);
	const typeNames = allTypes.map((t) => t.name);
	const fieldsSpec = allFields.map((f) => `<field name="${f.name}" type="${f.data_type}" />`).join('\\n');

	const metadata = await llm.extractMetadata(documentContent, doc.title, corrNames, typeNames, tagsNames, fieldsSpec);

	logger.info(`[Doc #${doc.id}] LLM Extraction Complete: ${JSON.stringify(metadata, null, 2)}`);

	await applyExtractedMetadata(
		doc, metadata, allTags, allCorrs, allTypes, allFields,
		tagAiAuto, tagAiOcrAuto, tagAiOcrDone, tagAiDone, tagAiFailed, hasOcrAuto,
	);
}

export async function processDocument(
	docId: number,
	forcedTags?: { tagAiAuto: Tag; tagAiOcrAuto: Tag; tagAiOcrDone: Tag; tagAiDone?: Tag; tagAiFailed: Tag },
) {
	const doc = await paperless.getDocument(docId);
	logger.info(`Processing Document #${doc.id}: "${doc.title}"`);

	// Ensure we have tags
	const tagAiAuto = forcedTags?.tagAiAuto ?? (await paperless.ensureTag(config.TAG_AI_AUTO));
	const tagAiOcrAuto = forcedTags?.tagAiOcrAuto ?? (await paperless.ensureTag(config.TAG_AI_OCR_AUTO));
	const tagAiOcrDone = forcedTags?.tagAiOcrDone ?? (await paperless.ensureTag(config.TAG_AI_OCR_DONE));
	const tagAiDone =
		forcedTags?.tagAiDone ?? (config.TAG_AI_DONE ? await paperless.ensureTag(config.TAG_AI_DONE) : undefined);
	const tagAiFailed = forcedTags?.tagAiFailed ?? (await paperless.ensureTag(config.TAG_AI_FAILED));

	const hasOcrAuto = doc.tags.includes(tagAiOcrAuto.id);
	const hasAiAuto = doc.tags.includes(tagAiAuto.id);
	const isVisionMode = config.OPENAI_COMPATIBLE_VISION && !!config.OPENAI_COMPATIBLE_API_URL;
	let errorOccurred = false;

	try {
		// Decide up front whether this document even needs OCR — a born-digital PDF under
		// OCR_MODE=auto (or any PDF under OCR_MODE=skip) never reaches Docling or the vision
		// rasterizer below; it goes straight to metadata extraction using its own embedded text.
		const ocrPlan: OcrPlan = hasOcrAuto ? await planOcr(doc) : { action: 'none' };

		if (hasOcrAuto && hasAiAuto && isVisionMode && ocrPlan.action === 'ocr') {
			// Vision path: combined OCR + metadata extraction in one LLM call
			const { pages, supported } = await getDocumentImages(doc, ocrPlan.buffer);

			if (!supported) {
				logger.warn(
					`[Doc #${doc.id}] MIME type '${doc.mime_type}' is not supported for vision mode. Falling back to Docling + text LLM.`,
				);
				// Fall through to standard two-phase path below
				await runStandardPath(
					doc, hasOcrAuto, hasAiAuto, ocrPlan,
					tagAiAuto, tagAiOcrAuto, tagAiOcrDone, tagAiDone, tagAiFailed,
				);
			} else {
				logger.info(`[Doc #${doc.id}] Vision OCR+metadata extraction (${pages.length} page(s))...`);

				const [allTags, allCorrs, allTypes, allFields] = await Promise.all([
					paperless.getTags(),
					paperless.getCorrespondents(),
					paperless.getDocumentTypes(),
					paperless.getCustomFields(),
				]);

				const aiTagIds = [tagAiAuto.id, tagAiOcrAuto.id, tagAiOcrDone.id, tagAiFailed.id];
				if (tagAiDone) aiTagIds.push(tagAiDone.id);
				const filteredTags = allTags.filter((t) => !aiTagIds.includes(t.id));

				const tagsNames = filteredTags.map((t) => t.name);
				const corrNames = allCorrs.map((c) => c.name);
				const typeNames = allTypes.map((t) => t.name);
				const fieldsSpec = allFields.map((f) => `<field name="${f.name}" type="${f.data_type}" />`).join('\\n');

				const visionResult = await llm.extractMetadataWithVision(
					pages,
					doc.title,
					corrNames,
					typeNames,
					tagsNames,
					fieldsSpec,
				);

				logger.info(`[Doc #${doc.id}] Vision extraction complete: ${JSON.stringify({ ...visionResult, ocr_content: `[${visionResult.ocr_content.length} chars]` }, null, 2)}`);

				await paperless.setDocumentContent(doc.id, visionResult.ocr_content);
				await paperless.addTagToDocument(doc.id, tagAiOcrDone.id);

				await applyExtractedMetadata(
					doc, visionResult, allTags, allCorrs, allTypes, allFields,
					tagAiAuto, tagAiOcrAuto, tagAiOcrDone, tagAiDone, tagAiFailed, true,
				);
			}
		} else {
			// Standard two-phase path — also handles the 'embedded' (born-digital PDF) and 'none'
			// (OCR_MODE=skip on a non-PDF) outcomes from planOcr, since neither needs Docling or vision.
			await runStandardPath(
				doc, hasOcrAuto, hasAiAuto, ocrPlan,
				tagAiAuto, tagAiOcrAuto, tagAiOcrDone, tagAiDone, tagAiFailed,
			);
		}

		logger.info(`[Doc #${doc.id}] Finished processing successfully.`);
	} catch (e: any) {
		logger.withError(e).error(`[Doc #${doc.id}] Flow Error`);
		errorOccurred = true;
	} finally {
		if (errorOccurred) {
			logger.info(`[Doc #${doc.id}] Cleaning up tags and appending failure tag.`);
			await paperless.removeTagFromDocument(doc.id, tagAiAuto.id);
			await paperless.removeTagFromDocument(doc.id, tagAiOcrAuto.id);
			await paperless.addTagToDocument(doc.id, tagAiFailed.id);
		}
	}
}

async function runStandardPath(
	doc: Document,
	hasOcrAuto: boolean,
	hasAiAuto: boolean,
	ocrPlan: OcrPlan,
	tagAiAuto: Tag,
	tagAiOcrAuto: Tag,
	tagAiOcrDone: Tag,
	tagAiDone: Tag | undefined,
	tagAiFailed: Tag,
): Promise<void> {
	// Phase 1: OCR (or the born-digital / skip-mode equivalent)
	// documentContent carries whatever text this phase produced, so phase 2 doesn't have to fetch
	// it back from Paperless right after we just wrote it.
	let documentContent: string | undefined;
	let ranOcr = false;

	if (hasOcrAuto) {
		if (ocrPlan.action === 'embedded') {
			logger.info(`[Doc #${doc.id}] Using the PDF's own embedded text (${ocrPlan.text.length} chars); OCR not needed.`);
			await paperless.setDocumentContent(doc.id, ocrPlan.text);
			await paperless.addTagToDocument(doc.id, tagAiOcrDone.id);
			documentContent = ocrPlan.text;
			ranOcr = true;
		} else if (ocrPlan.action === 'ocr') {
			logger.info(`[Doc #${doc.id}] Doing OCR via Docling...`);

			const extension =
				typeof doc.original_file_name === 'string' && doc.original_file_name.length > 0
					? doc.original_file_name.split('.').pop()
					: 'pdf';

			const fileBuffer = ocrPlan.buffer ?? (await paperless.downloadDocument(doc.id, true));
			const markdown = await docling.processFile(fileBuffer, `doc_${doc.id}.${extension}`);

			await paperless.setDocumentContent(doc.id, markdown);
			await paperless.addTagToDocument(doc.id, tagAiOcrDone.id);
			documentContent = markdown;
			ranOcr = true;
		} else {
			// 'none': OCR_MODE=skip on a non-PDF document. Mirrors Paperless's own `off` mode, where
			// image documents simply get no text. tagAiOcrDone is intentionally not applied — no OCR ran.
			logger.info(`[Doc #${doc.id}] OCR_MODE=skip: no OCR performed for non-PDF document.`);
		}
	}

	// Phase 2: Metadata via LLM
	if (hasAiAuto) {
		const content = documentContent ?? (await paperless.getDocumentText(doc.id));
		await runMetadataPhase(doc, content, tagAiAuto, tagAiOcrAuto, tagAiOcrDone, tagAiDone, tagAiFailed, ranOcr);
	} else if (hasOcrAuto) {
		// Only OCR was requested. Remove the trigger tag since phase 2 won't patch
		await paperless.removeTagFromDocument(doc.id, tagAiOcrAuto.id);
	}
}
