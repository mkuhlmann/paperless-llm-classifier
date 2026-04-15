import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from './config';
import { logger } from './log';
import { format } from 'date-fns';
import { createOpenAICompatible, OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import type { GoogleGenerativeAIModelId } from '@ai-sdk/google/internal';

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

export type ExtractedMetadata = z.infer<typeof extractedMetadataSchema>;

export class LlmClient {
	async extractMetadata(
		content: string,
		originalTitle: string,
		availableCorrespondents: string[],
		availableDocumentTypes: string[],
		availableTags: string[],
		customFieldsSpec: string,
	): Promise<ExtractedMetadata> {
		const today = format(new Date(), 'yyyy-MM-dd');

		const systemPrompt = `
You are an expert document analysis AI. Your task is to extract metadata from the provided document and return it as a strictly formatted JSON object.
The document language is most likely ${config.LLM_ANSWER_LANGUAGE}. You are very knowledgeable. Think and respond with confidence.
Apply the following rules for each JSON field:

<rules field="title">
Find a suitable document title based on the content (which may contain OCR errors).
If the original title is already adding value and not just a technical filename, you can enhance your suggestion with it.
Avoid including file extensions. ${config.OWN_NAME ? `Also, avoid including the name "${config.OWN_NAME}" in the title, as it is just the user's name and doesn't add value.` : ''}
</rules>

<rules field="correspondent">
Suggest the sender/recipient (who you receive the document from or send to).
Try your best to select from the available correspondents. If really nothing matches, come up with a new one.
Avoid legal/financial suffixes (e.g., use "Microsoft" not "Microsoft Ireland Operations Limited", "Amazon" not "Amazon EU S.a.r.l.").
If you can't find a suitable correspondent, return null.

<available_correspondents>
${availableCorrespondents.join(', ')}
</available_correspondents>
</rules>

<rules field="created_date">
Find the date when the document was created.
Respond only with the date in YYYY-MM-DD format.
If no day was found, use the first day of the month.
If no month was found, use January.
If no date was found at all, use today's date: ${today}.
</rules>

<rules field="document_type">
Select the most appropriate document type for the document from the list of available document types.
Only select a document type from the provided list. Be selective!
If none of the available document types fit the document, return null.

<available_document_types>
${availableDocumentTypes.join(', ')}
</available_document_types>
</rules>

<rules field="tags">
Select appropriate tags for the document from the list of available tags.
Only select tags from the provided list. Be very selective! Too many tags make it less discoverable.

<available_tags>
${availableTags.join(', ')}
</available_tags>
</rules>

<rules field="custom_fields">
Analyze the document to find values for custom fields. YOU MUST ONLY include fields that are listed in the custom fields spec. DO NOT ADD OTHER FIELDS that are not in the spec. If a field is not found or not relevant to the document, omit it.
<custom_fields_spec>
${customFieldsSpec}
</custom_fields_spec>

For fields of type 'monetary', the value must be a number with two decimal places and a period as the decimal separator. You must also identify the currency and place its three-letter code (e.g., EUR, USD) at the beginning of the value. For example, '1.664,58 €' becomes \`EUR1664.58\`.

</rules>
`;

		const userPrompt = `
<original_title>${originalTitle}</original_title>

<content>
${content}
</content>
    `;

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
}

export const llm = new LlmClient();
