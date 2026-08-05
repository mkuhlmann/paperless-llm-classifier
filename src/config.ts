import { z } from 'zod';
import { logger } from './log';

export const EnvSchema = z.object({
	PAPERLESS_URL: z
		.url()
		.describe('Base URL of Paperless-ngx')
		.transform((url) => url.replace(/\/$/, '')),
	PAPERLESS_TOKEN: z.string().min(1).describe('API Token for Paperless-ngx'),
	DOCLING_URL: z
		.url()
		.default('http://localhost:50000')
		.describe('Base URL of Docling service')
		.transform((url) => url.replace(/\/$/, '')),
	GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).describe('API Key for Gemini'),
	GOOGLE_AI_MODEL: z
		.string()
		.default('gemini-2.5-flash')
		.describe('Gemini model to use — as the primary model, or as fallback when OPENAI_COMPATIBLE_API_URL is unset/unreachable'),
	POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
	TAG_AI_AUTO: z.string().default('ai-auto'),
	TAG_AI_OCR_AUTO: z.string().default('ai-ocr-auto'),
	TAG_AI_OCR_DONE: z.string().default('ai-ocr-done'),
	TAG_AI_DONE: z.string().min(1).optional(),
	TAG_AI_FAILED: z.string().default('ai-failed'),
	OCR_MODE: z
		.enum(['auto', 'force', 'skip'])
		.default('auto')
		.describe(
			'auto: skip OCR for born-digital PDFs and use their embedded text; force: always OCR; skip: never OCR',
		),
	OCR_MIN_CHARS_PER_PAGE: z
		.coerce.number()
		.int()
		.nonnegative()
		.default(100)
		.describe('Visible characters per page above which a PDF is considered born-digital (auto mode)'),
	ALLOW_NEW_CORRESPONDENT: z.coerce.boolean().default(false),
	LLM_ANSWER_LANGUAGE: z.string().default('English').describe('Language for LLM answers'),
	OWN_NAME: z.string().describe('The name of the user, to avoid including it in metadata extraction').optional(),
	OPENAI_COMPATIBLE_API_URL: z.string().url().optional().describe('URL for OpenAI-compatible API'),
	OPENAI_COMPATIBLE_API_KEY: z.string().optional().describe('API Key for OpenAI-compatible API'),
	OPENAI_COMPATIBLE_MODEL: z.string().optional().describe('Model name for OpenAI-compatible API'),
	OPENAI_COMPATIBLE_VISION: z.coerce.boolean().default(false).describe('Whether the OpenAI-compatible model supports vision/image input for combined OCR+classification'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let config: EnvConfig;

try {
	config = EnvSchema.parse(process.env);
	logger.info('Configuration loaded successfully.');
} catch (error) {
	if (error instanceof z.ZodError) {
		logger.withError(error).error('Configuration validation failed');
	} else {
		logger.withError(error as Error).error('Unknown configuration error');
	}
	process.exit(1);
}

export { config };
