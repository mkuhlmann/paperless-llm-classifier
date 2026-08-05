import { describe, expect, test } from 'bun:test';
import { analyzePdfText, extractPdfText } from './pdf';

/**
 * Hand-rolled minimal single-page PDF builder for test fixtures, rather than generating them via
 * ocrmypdf/ghostscript (not guaranteed to be installed in every environment these tests run in).
 * It still produces spec-valid PDF objects: real Type1 font text (default rendering mode 0,
 * visible) for born-digital content, and — when `withImage` is set — a page image XObject with
 * text drawn under `3 Tr` (invisible) for the OCR-layer fixture. That's exactly the structure
 * OCRmyPDF's "sandwich" renderer produces (a page image with an invisible Tesseract text layer on
 * top), and the only signal analyzePdfText() reads to tell the two apart.
 */
function buildFixturePdf(opts: { content: string; withImage?: boolean }): Buffer {
	const { content, withImage } = opts;
	const resources = withImage
		? '<< /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >>'
		: '<< /Font << /F1 4 0 R >> >>';

	const objects: Array<string | { stream: Buffer; extra?: string }> = [
		`<< /Type /Catalog /Pages 2 0 R >>`,
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources ${resources} /Contents 5 0 R >>`,
		`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
		{ stream: Buffer.from(content, 'latin1') },
	];
	if (withImage) {
		// 2x2 raw RGB image, uncompressed — just needs to exist as an XObject the content stream
		// draws; its pixel content is irrelevant to text-rendering-mode detection.
		const imgData = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
		objects.push({
			stream: imgData,
			extra: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8',
		});
	}

	const chunks: Buffer[] = [];
	const offsets: number[] = [];
	let pos = 0;
	const push = (buf: Buffer) => {
		chunks.push(buf);
		pos += buf.length;
	};

	push(Buffer.from('%PDF-1.4\n', 'latin1'));
	objects.forEach((obj, idx) => {
		offsets.push(pos);
		const num = idx + 1;
		if (typeof obj === 'string') {
			push(Buffer.from(`${num} 0 obj\n${obj}\nendobj\n`, 'latin1'));
		} else {
			const dict = `<< ${obj.extra ?? ''} /Length ${obj.stream.length} >>`;
			push(Buffer.from(`${num} 0 obj\n${dict}\nstream\n`, 'latin1'));
			push(obj.stream);
			push(Buffer.from(`\nendstream\nendobj\n`, 'latin1'));
		}
	});

	const xrefStart = pos;
	const count = objects.length + 1;
	let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
	for (const off of offsets) {
		xref += `${String(off).padStart(10, '0')} 00000 n \n`;
	}
	push(Buffer.from(xref, 'latin1'));
	push(Buffer.from(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, 'latin1'));

	return Buffer.concat(chunks);
}

const BORN_DIGITAL_CONTENT = `BT /F1 12 Tf 10 100 Td (Hello Born Digital) Tj ET`;
const INVISIBLE_OCR_LAYER_CONTENT = `q 200 0 0 200 0 0 cm /Im1 Do Q BT /F1 12 Tf 3 Tr 10 100 Td (Invisible OCR Text Layer) Tj ET`;
const IMAGE_ONLY_CONTENT = `q 200 0 0 200 0 0 cm /Im1 Do Q`;

describe('analyzePdfText', () => {
	test('classifies a born-digital PDF as visible text', async () => {
		const pdf = buildFixturePdf({ content: BORN_DIGITAL_CONTENT });
		const result = await analyzePdfText(pdf);
		expect(result.visibleChars).toBeGreaterThan(0);
		expect(result.invisibleChars).toBe(0);
		expect(result.pageCount).toBe(1);
	});

	test('classifies a scanned PDF with an OCRmyPDF-style invisible text layer as invisible text', async () => {
		// The case a naive "does it have text?" check gets wrong: this document has plenty of text,
		// but all of it is the OCR layer sitting invisibly on top of the scanned page image — it must
		// NOT be treated as born-digital.
		const pdf = buildFixturePdf({ withImage: true, content: INVISIBLE_OCR_LAYER_CONTENT });
		const result = await analyzePdfText(pdf);
		expect(result.visibleChars).toBe(0);
		expect(result.invisibleChars).toBeGreaterThan(0);
	});

	test('reports zero characters for an image-only PDF with no text at all', async () => {
		const pdf = buildFixturePdf({ withImage: true, content: IMAGE_ONLY_CONTENT });
		const result = await analyzePdfText(pdf);
		expect(result.visibleChars).toBe(0);
		expect(result.invisibleChars).toBe(0);
		expect(result.pageCount).toBe(1);
	});
});

describe('extractPdfText', () => {
	test('extracts visible text from a born-digital PDF', async () => {
		const pdf = buildFixturePdf({ content: BORN_DIGITAL_CONTENT });
		const text = await extractPdfText(pdf);
		expect(text).toContain('Hello Born Digital');
	});

	test('extracts invisible OCR-layer text too (needed for OCR_MODE=skip, which reuses it)', async () => {
		const pdf = buildFixturePdf({ withImage: true, content: INVISIBLE_OCR_LAYER_CONTENT });
		const text = await extractPdfText(pdf);
		expect(text).toContain('Invisible OCR Text Layer');
	});
});

describe('buffer reuse', () => {
	test('the same buffer can be analyzed and then extracted without corruption', async () => {
		// pdf.js detaches whatever typed array it's handed. planOcr() in processor.ts calls
		// analyzePdfText() and then extractPdfText() on the same downloaded buffer in sequence — if
		// either function views the buffer instead of copying it, the second call throws.
		const pdf = buildFixturePdf({ content: `BT /F1 12 Tf 10 100 Td (Reused Buffer Text) Tj ET` });
		await analyzePdfText(pdf);
		const text = await extractPdfText(pdf);
		expect(text).toContain('Reused Buffer Text');
	});
});
