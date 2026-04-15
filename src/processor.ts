import { config } from './config';
import { logger } from './log';
import { paperless } from './paperless';
import type { Tag } from './paperless';
import { docling } from './docling';
import { llm } from './llm';

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
	let errorOccurred = false;

	try {
		// Phase 1: OCR via Docling
		if (hasOcrAuto) {
			logger.info(`[Doc #${doc.id}] Doing OCR via Docling...`);

			const extension =
				typeof doc.original_file_name === 'string' && doc.original_file_name.length > 0
					? doc.original_file_name.split('.').pop()
					: 'pdf';

			const fileBuffer = await paperless.downloadDocument(doc.id, true);
			const markdown = await docling.processFile(fileBuffer, `doc_${doc.id}.${extension}`);

			await paperless.setDocumentContent(doc.id, markdown);
			await paperless.addTagToDocument(doc.id, tagAiOcrDone.id);
		}

		// Phase 2: Metadata via LLM
		if (hasAiAuto) {
			let documentContent = await paperless.getDocumentText(doc.id);
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

			// Filter out AI-related tags from the list provided to the LLM
			const aiTagIds = [tagAiAuto.id, tagAiOcrAuto.id, tagAiOcrDone.id, tagAiFailed.id];
			if (tagAiDone) {
				aiTagIds.push(tagAiDone.id);
			}
			const filteredTags = allTags.filter((t) => !aiTagIds.includes(t.id));

			const tagsNames = filteredTags.map((t) => t.name);
			const corrNames = allCorrs.map((c) => c.name);
			const typeNames = allTypes.map((t) => t.name);
			const fieldsSpec = allFields.map((f) => `<field name="${f.name}" type="${f.data_type}" />`).join('\\n');

			const metadata = await llm.extractMetadata(
				documentContent,
				doc.title,
				corrNames,
				typeNames,
				tagsNames,
				fieldsSpec,
			);

			logger.info(`[Doc #${doc.id}] LLM Extraction Complete: ${JSON.stringify(metadata, null, 2)}`);

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

			// Patch Document
			logger.info(`[Doc #${doc.id}] Applying new metadata and tags to Paperless...`);
			await paperless.setupDocumentMetadata(doc.id, {
				title: metadata.title,
				correspondentId: correspondentId,
				documentTypeId: documentTypeId,
				createdDate: metadata.created_date,
				tags: activeTagsIds,
				customFields: customFieldsData.length > 0 ? customFieldsData : undefined,
			});
		} else if (hasOcrAuto) {
			// Only OCR was requested. Remove the trigger tag since phase 2 won't patch
			await paperless.removeTagFromDocument(doc.id, tagAiOcrAuto.id);
		}

		logger.info(`[Doc #${doc.id}] Finished processing successfully.`);
	} catch (e: any) {
		logger.withError(e).error(`[Doc #${doc.id}] Flow Error`);
		errorOccurred = true;
	} finally {
		if (errorOccurred) {
			logger.info(`[Doc #${doc.id}] Cleaning up tags and appending failure tag.`);
			// If it failed, we want to clear the triggers and add the failure tag.
			await paperless.removeTagFromDocument(doc.id, tagAiAuto.id);
			await paperless.removeTagFromDocument(doc.id, tagAiOcrAuto.id);
			await paperless.addTagToDocument(doc.id, tagAiFailed.id);
		}
	}
}
