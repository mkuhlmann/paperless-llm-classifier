import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from './config';
import { logger } from './log';
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import type { GoogleGenerativeAIModelId } from '@ai-sdk/google/internal';
import {
	buildMetadataSystemPrompt,
	buildMetadataUserPrompt,
	buildVisionMetadataSystemPrompt,
} from './prompts';

const google = createGoogleGenerativeAI({
	apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
});

const llamaModel = config.OPENAI_COMPATIBLE_API_URL
	? new OpenAICompatibleChatLanguageModel(config.OPENAI_COMPATIBLE_MODEL ?? 'unknown', {
			provider: 'openai-compatible',
			url: ({ path }) => `${config.OPENAI_COMPATIBLE_API_URL}${path}`,
			headers: () => ({
				Authorization: `Bearer ${config.OPENAI_COMPATIBLE_API_KEY}`,
			}),
			supportsStructuredOutputs: true,
		})
	: null;

async function determinateModel(fallback: GoogleGenerativeAIModelId = 'gemini-3-flash-preview') {
	if (llamaModel && config.OPENAI_COMPATIBLE_API_URL) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 3000);
			const response = await fetch(`${config.OPENAI_COMPATIBLE_API_URL}/models`, {
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${config.OPENAI_COMPATIBLE_API_KEY}`,
				},
				method: 'GET',
			});
			clearTimeout(timeoutId);
			if (response.ok) {
				return llamaModel;
			}
		} catch (error) {
			logger.withError(error as Error).warn('Llama inference not reachable, falling back to Gemini');
		}
	}
	return google(fallback);
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

		const model = await determinateModel();
		logger.info(`Sending metadata extraction request to ${model.modelId}...`);

		const result = await generateText({
			model: model,
			output: Output.object({
				schema: extractedMetadataSchema,
			}),
			system: systemPrompt,
			prompt: userPrompt,
		});

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
		if (!llamaModel) {
			throw new Error('Vision extraction requires OPENAI_COMPATIBLE_API_URL to be configured.');
		}

		const systemPrompt = buildVisionMetadataSystemPrompt(
			availableCorrespondents,
			availableDocumentTypes,
			availableTags,
			customFieldsSpec,
		);
		const userText = `<original_title>${originalTitle}</original_title>`;

		Bun.write('logs/last_prompt.txt', `${systemPrompt}\n\n[${pages.length} page image(s)]\n${userText}`);

		logger.info(`Sending vision OCR+metadata request to ${llamaModel.modelId} (${pages.length} page(s))...`);

		const result = await generateText({
			model: llamaModel,
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
		});

		logger.info('Received vision OCR+metadata from LLM.');
		return result.output;
	}
}

export const llm = new LlmClient();
