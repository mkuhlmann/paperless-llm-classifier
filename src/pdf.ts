import { extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { logger } from './log';

// unpdf wraps pdf.js with a build specifically compiled for serverless/edge/Bun runtimes — no
// separate worker file to resolve on disk, no DOM assumptions. Plain pdfjs-dist's worker is loaded
// via a runtime-relative `import("./pdf.worker.mjs")`, which breaks once `bun build` flattens
// everything into a single-file bundle (as the Dockerfile does); unpdf's build doesn't have that
// failure mode.

// PDF spec default text rendering mode is 0 (fill / visible) when no `Tr` operator has been seen yet.
const DEFAULT_TEXT_RENDERING_MODE = 0;
// Mode 3 = invisible (PDF 32000-1, Table 106). OCRmyPDF's "sandwich" renderer draws its Tesseract
// output this way, on top of the page image — that's the signature this module looks for to tell a
// scanned document (already carrying an OCR text layer) apart from a born-digital one.
const INVISIBLE_TEXT_RENDERING_MODE = 3;

export interface PdfTextAnalysis {
	pageCount: number;
	/** Character count drawn in a visible rendering mode — i.e. actual born-digital content. */
	visibleChars: number;
	/** Character count drawn in an invisible rendering mode — the OCRmyPDF/Tesseract signature. */
	invisibleChars: number;
	visibleCharsPerPage: number;
}

// pdf.js takes ownership of and detaches the typed array passed as `data` (transferred internally,
// even in-process). Reusing the same Uint8Array/Buffer across two document loads throws
// `DataCloneError` on the second one — always hand it a fresh copy.
function toDocumentData(buffer: Buffer): Uint8Array {
	return new Uint8Array(buffer);
}

/**
 * Walks every page's content stream and buckets drawn text by rendering mode. Used to tell a
 * born-digital PDF (all visible text) apart from a scanned one that already carries an invisible
 * OCR text layer (e.g. applied by Paperless's own OCRmyPDF pass) — a plain "does it have text?"
 * check can't distinguish the two, since both have text.
 */
export async function analyzePdfText(buffer: Buffer): Promise<PdfTextAnalysis> {
	// unpdf doesn't expose a destroy() on the documents it returns (its own examples don't call one
	// either — this process is meant to be one-shot per document); cleanup() frees per-document
	// caches (fonts, images, decoded streams) promptly instead of waiting on GC, which matters here
	// since this runs inside a long-lived poll loop rather than a short script.
	let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
	try {
		// Only text operators matter here, but getOperatorList() would otherwise fully decode every
		// embedded image — expensive for scans, and JBIG2 ones fail outright since unpdf's build doesn't
		// ship pdf.js's jbig2.wasm. maxImageSize: 0 drops all images before decoding; the resulting
		// per-image "removed" warnings are silenced by keeping verbosity at errors-only.
		doc = await getDocumentProxy(toDocumentData(buffer), {
			maxImageSize: 0,
			verbosity: 0,
		});
		const pdfjs = await getResolvedPDFJS();
		let visibleChars = 0;
		let invisibleChars = 0;

		for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
			const page = await doc.getPage(pageNum);
			try {
				const opList = await page.getOperatorList();
				let renderMode = DEFAULT_TEXT_RENDERING_MODE;

				for (let i = 0; i < opList.fnArray.length; i++) {
					const fn = opList.fnArray[i];
					if (fn === pdfjs.OPS.setTextRenderingMode) {
						renderMode = opList.argsArray[i][0];
					} else if (fn === pdfjs.OPS.showText || fn === pdfjs.OPS.showSpacedText) {
						const glyphs = opList.argsArray[i][0];
						const charCount = Array.isArray(glyphs) ? glyphs.length : 0;
						if (renderMode === INVISIBLE_TEXT_RENDERING_MODE) {
							invisibleChars += charCount;
						} else {
							visibleChars += charCount;
						}
					}
				}
			} finally {
				page.cleanup();
			}
		}

		return {
			pageCount: doc.numPages,
			visibleChars,
			invisibleChars,
			visibleCharsPerPage: doc.numPages > 0 ? visibleChars / doc.numPages : 0,
		};
	} catch (err) {
		logger.withError(err as Error).error('Failed to analyze PDF text layer');
		throw new Error('PDF text analysis failed');
	} finally {
		doc?.cleanup();
	}
}

/**
 * Extracts all text from a PDF, page by page. This intentionally includes invisible text (e.g. an
 * existing OCR layer) — pdf.js's text extraction returns it regardless of rendering mode, which is
 * exactly what's wanted when reusing a document's already-OCRed content instead of re-running OCR.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
	let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
	try {
		doc = await getDocumentProxy(toDocumentData(buffer));
		const { text } = await extractText(doc, { mergePages: true });
		return text;
	} catch (err) {
		logger.withError(err as Error).error('Failed to extract PDF text');
		throw new Error('PDF text extraction failed');
	} finally {
		doc?.cleanup();
	}
}
