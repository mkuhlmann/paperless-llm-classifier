declare module 'bun' {
	interface Env {
		GOOGLE_GENERATIVE_AI_API_KEY: string;
		PAPERLESS_URL: string;
		PAPERLESS_TOKEN: string;
		DOCLING_URL: string;
		LLM_ANSWER_LANGUAGE: string;
		OPENAI_COMPATIBLE_API_URL: string;
		OPENAI_COMPATIBLE_API_KEY: string;
		OPENAI_COMPATIBLE_MODEL: string;
		OWN_NAME?: string;
		AI_MODEL?: string;
		POLL_INTERVAL_MS?: string;
		TAG_AI_AUTO?: string;
		TAG_AI_OCR_AUTO?: string;
		TAG_AI_OCR_DONE?: string;
		TAG_AI_FAILED?: string;
	}
}
