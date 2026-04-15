import { format } from 'date-fns';
import { config } from './config';

function buildMetadataRules(
	availableCorrespondents: string[],
	availableDocumentTypes: string[],
	availableTags: string[],
	customFieldsSpec: string,
	today: string,
): string {
	return `Apply the following rules for each JSON field:

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

</rules>`;
}

export function buildMetadataSystemPrompt(
	availableCorrespondents: string[],
	availableDocumentTypes: string[],
	availableTags: string[],
	customFieldsSpec: string,
): string {
	const today = format(new Date(), 'yyyy-MM-dd');
	return `You are an expert document analysis AI. Your task is to extract metadata from the provided document and return it as a strictly formatted JSON object.
The document language is most likely ${config.LLM_ANSWER_LANGUAGE}. You are very knowledgeable. Think and respond with confidence.
${buildMetadataRules(availableCorrespondents, availableDocumentTypes, availableTags, customFieldsSpec, today)}`;
}

export function buildMetadataUserPrompt(content: string, originalTitle: string): string {
	return `<original_title>${originalTitle}</original_title>

<content>
${content}
</content>`;
}

export function buildVisionMetadataSystemPrompt(
	availableCorrespondents: string[],
	availableDocumentTypes: string[],
	availableTags: string[],
	customFieldsSpec: string,
): string {
	const today = format(new Date(), 'yyyy-MM-dd');
	return `You are an expert document analysis AI. Your task has two parts:

**Part 1 — OCR:** The document is provided as one or more page images. Extract all text exactly as it appears on each page, preserving layout where possible. Use markdown formatting for tables and lists. Do not add commentary. Place the complete extracted text from all pages in the \`ocr_content\` field.

**Part 2 — Metadata:** Extract structured metadata from the document and return it as a strictly formatted JSON object.

The document language is most likely ${config.LLM_ANSWER_LANGUAGE}. You are very knowledgeable. Think and respond with confidence.
${buildMetadataRules(availableCorrespondents, availableDocumentTypes, availableTags, customFieldsSpec, today)}`;
}
