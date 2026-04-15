import { config } from './config';
import { logger } from './log';

export interface Document {
	id: number;
	title: string;
	tags: number[];
	custom_fields: Array<{ field: number; value: any }>;
	correspondent: number | null;
	document_type: number | null;
	created: string;
	original_file_name: string;
	mime_type: string;
}

export interface Tag {
	id: number;
	name: string;
}

export interface Correspondent {
	id: number;
	name: string;
}

export interface DocumentType {
	id: number;
	name: string;
}

export interface CustomField {
	id: number;
	name: string;
	data_type: string;
}

export class PaperlessClient {
	private baseUrl: string;
	private headers: Record<string, string>;

	constructor() {
		this.baseUrl = config.PAPERLESS_URL.replace(/\/$/, '');
		this.headers = {
			Authorization: `Token ${config.PAPERLESS_TOKEN}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
	}

	private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
		const url = `${this.baseUrl}/api${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
		const response = await fetch(url, {
			...options,
			headers: {
				...this.headers,
				...(options?.headers as Record<string, string> | undefined),
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger
				.withMetadata({ error: errorText })
				.error(`Paperless API error: ${response.status} ${response.statusText} at ${url}`);
			throw new Error(`Paperless API error: ${response.status} ${response.statusText}`);
		}

		if (response.status === 204) {
			return null as any;
		}
		return response.json() as Promise<T>;
	}

	async getTagByName(name: string): Promise<Tag | null> {
		const res = await this.request<{ results: Tag[] }>(`/tags/?name__iexact=${encodeURIComponent(name)}`);
		return res.results.length > 0 ? (res.results[0] ?? null) : null;
	}

	async createTag(name: string): Promise<Tag> {
		return this.request<Tag>('/tags/', {
			method: 'POST',
			body: JSON.stringify({ name }),
		});
	}

	async ensureTag(name: string): Promise<Tag> {
		const tag = await this.getTagByName(name);
		return tag || this.createTag(name);
	}

	async getDocumentsByTagParams(tagsIdStr: string): Promise<{ results: Document[] }> {
		return this.request<{ results: Document[] }>(`/documents/?tags__id__in=${tagsIdStr}&page_size=10`);
	}

	async getTags(): Promise<Tag[]> {
		const res = await this.request<{ results: Tag[] }>('/tags/?page_size=1000');
		return res.results;
	}

	async addTagToDocument(docId: number, tagId: number): Promise<void> {
		const doc = await this.request<any>(`/documents/${docId}/`);
		const tags: number[] = doc.tags || [];
		if (!tags.includes(tagId)) {
			tags.push(tagId);
			await this.request(`/documents/${docId}/`, {
				method: 'PATCH',
				body: JSON.stringify({ tags }),
			});
		}
	}

	async removeTagFromDocument(docId: number, tagId: number): Promise<void> {
		const doc = await this.request<any>(`/documents/${docId}/`);
		const tags: number[] = doc.tags || [];
		if (tags.includes(tagId)) {
			const newTags = tags.filter((id) => id !== tagId);
			await this.request(`/documents/${docId}/`, {
				method: 'PATCH',
				body: JSON.stringify({ tags: newTags }),
			});
		}
	}

	async getCorrespondents(): Promise<Correspondent[]> {
		const res = await this.request<{ results: Correspondent[] }>('/correspondents/?page_size=1000');
		return res.results;
	}

	async createCorrespondent(name: string): Promise<Correspondent> {
		return this.request<Correspondent>('/correspondents/', {
			method: 'POST',
			body: JSON.stringify({ name }),
		});
	}

	async ensureCorrespondent(name: string): Promise<Correspondent> {
		const corrs = await this.getCorrespondents();
		const existing = corrs.find((c) => c.name.toLowerCase() === name.toLowerCase());
		return existing || this.createCorrespondent(name);
	}

	async getDocumentTypes(): Promise<DocumentType[]> {
		const res = await this.request<{ results: DocumentType[] }>('/document_types/?page_size=1000');
		return res.results;
	}

	async getCustomFields(): Promise<CustomField[]> {
		const res = await this.request<{ results: CustomField[] }>('/custom_fields/?page_size=100');
		return res.results;
	}

	async downloadDocument(id: number, original: boolean = true): Promise<Buffer> {
		const endpoint = `/documents/${id}/download/${original ? '?original=true' : ''}`;
		const url = `${this.baseUrl}/api${endpoint}`;

		// fetch as array buffer
		const response = await fetch(url, { headers: this.headers });
		if (!response.ok) {
			throw new Error(`Failed to download document ${id}: ${response.statusText}`);
		}
		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	async getDocumentText(id: number): Promise<string> {
		const doc = await this.request<any>(`/documents/${id}/`);
		return doc.content || '';
	}

	async setDocumentContent(id: number, content: string): Promise<void> {
		await this.request(`/documents/${id}/`, {
			method: 'PATCH',
			body: JSON.stringify({ content }),
		});
	}

	async getDocument(id: number): Promise<Document> {
		return this.request<Document>(`/documents/${id}/`);
	}

	async setupDocumentMetadata(
		docId: number,
		metadata: {
			title?: string;
			correspondentId?: number | null;
			documentTypeId?: number | null;
			createdDate?: string;
			tags?: number[];
			customFields?: Array<{ field: number; value: any }>;
		},
	): Promise<void> {
		const body: Record<string, any> = {};
		if (metadata.title) body.title = metadata.title;
		if (metadata.correspondentId !== undefined) body.correspondent = metadata.correspondentId;
		if (metadata.documentTypeId !== undefined) body.document_type = metadata.documentTypeId;
		if (metadata.createdDate) {
			body.created = metadata.createdDate;
			body.archive_serial_number = null; // often paperless needs this if date changes, maybe keep it simple
		}
		if (metadata.tags) body.tags = metadata.tags;
		if (metadata.customFields) body.custom_fields = metadata.customFields;

		await this.request(`/documents/${docId}/`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		});
	}
}

export const paperless = new PaperlessClient();
