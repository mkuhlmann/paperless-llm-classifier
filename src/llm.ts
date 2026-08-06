import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { config } from './config';
import { logger } from './log';
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import { buildMetadataSystemPrompt, buildMetadataUserPrompt, buildVisionMetadataSystemPrompt } from './prompts';

interface Provider {
	name: 'primary' | 'secondary';
	model: LanguageModel;
	modelId: string;
	vision: boolean;
}

function buildProvider(
	name: Provider['name'],
	url: string,
	apiKey: string | undefined,
	modelId: string,
	vision: boolean,
): Provider {
	return {
		name,
		modelId,
		vision,
		model: new OpenAICompatibleChatLanguageModel(modelId, {
			provider: 'openai-compatible',
			url: ({ path }) => `${url}${path}`,
			headers: () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			supportsStructuredOutputs: true,
		}),
	};
}

const providers: Provider[] = [
	buildProvider(
		'primary',
		config.OPENAI_COMPATIBLE_API_URL,
		config.OPENAI_COMPATIBLE_API_KEY,
		config.OPENAI_COMPATIBLE_MODEL,
		config.OPENAI_COMPATIBLE_VISION,
	),
	...(config.OPENAI_COMPATIBLE_SECONDARY_API_URL && config.OPENAI_COMPATIBLE_SECONDARY_MODEL
		? [
				buildProvider(
					'secondary',
					config.OPENAI_COMPATIBLE_SECONDARY_API_URL,
					config.OPENAI_COMPATIBLE_SECONDARY_API_KEY,
					config.OPENAI_COMPATIBLE_SECONDARY_MODEL,
					config.OPENAI_COMPATIBLE_SECONDARY_VISION,
				),
			]
		: []),
];

/** True when at least one configured provider can take image input (for vision mode). */
export const visionAvailable = providers.some((p) => p.vision);

/**
 * Runs `fn` against each eligible provider in order (primary first, then secondary), returning the
 * first success. A provider is only eligible when `needsVision` is false or the provider supports
 * vision. Failures are logged and the next provider is tried; if every candidate fails, the last
 * error is rethrown.
 */
async function withFallback<T>(needsVision: boolean, fn: (model: LanguageModel) => Promise<T>): Promise<T> {
	const candidates = providers.filter((p) => !needsVision || p.vision);
	if (candidates.length === 0) {
		throw new Error(
			needsVision
				? 'No configured LLM provider supports vision. Set OPENAI_COMPATIBLE_VISION=true (or the secondary equivalent).'
				: 'No LLM provider configured.',
		);
	}

	let lastError: unknown;
	for (const [index, provider] of candidates.entries()) {
		logger.info(`Sending request to ${provider.name} provider (${provider.modelId})...`);
		try {
			return await fn(provider.model);
		} catch (error) {
			lastError = error;
			const nextProvider = candidates[index + 1];
			if (nextProvider) {
				logger
					.withError(error as Error)
					.warn(`Provider ${provider.name} (${provider.modelId}) failed, trying ${nextProvider.name}...`);
			}
		}
	}
	throw lastError;
}

export const extractedMetadataSchema = z.object({
	title: z.string().describe('A suitable title based on the document content.'),
	correspondent: z.string().nullable().describe('The most relevant correspondent. Leave null if not found.'),
	created_date: z
		.string()
		.describe('The creation date of the document in YYYY-MM-DD format. Fallback to today if not found.'),
	document_type: z
		.string()
		.nullable()
		.describe('The single most appropriate document type from the provided list, or null if none fit.'),
	tags: z.array(z.string()).describe('A list of appropriate tags selected from the provided options.'),
	custom_fields: z
		.array(
			z.object({
				field: z.string(),
				value: z.string(),
			}),
		)
		.describe('Extracted custom field values based on instructions. Only include relevant fields.'),
});

export const visionExtractedMetadataSchema = extractedMetadataSchema.extend({
	ocr_content: z
		.string()
		.describe('All text extracted from all document pages, preserving layout with markdown formatting.'),
});

export type ExtractedMetadata = z.infer<typeof extractedMetadataSchema>;
export type VisionExtractedMetadata = z.infer<typeof visionExtractedMetadataSchema>;

export class LlmClient {
	async extractMetadata(
		content: string,
		originalTitle: string,
		availableCorrespondents: string[],
		availableDocumentTypes: string[],
		availableTags: string[],
		customFieldsSpec: string,
	): Promise<ExtractedMetadata> {
		const systemPrompt = buildMetadataSystemPrompt(
			availableCorrespondents,
			availableDocumentTypes,
			availableTags,
			customFieldsSpec,
		);
		const userPrompt = buildMetadataUserPrompt(content, originalTitle);

		Bun.write('logs/last_prompt.txt', `${systemPrompt}\n\n${userPrompt}`);

		const result = await withFallback(false, (model) =>
			generateText({
				model,
				output: Output.object({
					schema: extractedMetadataSchema,
				}),
				system: systemPrompt,
				prompt: userPrompt,
			}),
		);

		logger.info('Received extracted metadata from LLM.');
		return result.output;
	}

	async extractMetadataWithVision(
		pages: Array<{ buffer: Buffer; mimeType: string }>,
		originalTitle: string,
		availableCorrespondents: string[],
		availableDocumentTypes: string[],
		availableTags: string[],
		customFieldsSpec: string,
	): Promise<VisionExtractedMetadata> {
		const systemPrompt = buildVisionMetadataSystemPrompt(
			availableCorrespondents,
			availableDocumentTypes,
			availableTags,
			customFieldsSpec,
		);
		const userText = `<original_title>${originalTitle}</original_title>`;

		Bun.write('logs/last_prompt.txt', `${systemPrompt}\n\n[${pages.length} page image(s)]\n${userText}`);

		const result = await withFallback(true, (model) =>
			generateText({
				model,
				output: Output.object({
					schema: visionExtractedMetadataSchema,
				}),
				system: systemPrompt,
				messages: [
					{
						role: 'user',
						content: [
							...pages.map(({ buffer, mimeType }) => ({
								type: 'image' as const,
								image: buffer,
								mimeType,
							})),
							{ type: 'text' as const, text: userText },
						],
					},
				],
			}),
		);

		logger.info('Received vision OCR+metadata from LLM.');
		return result.output;
	}
}

export const llm = new LlmClient();
