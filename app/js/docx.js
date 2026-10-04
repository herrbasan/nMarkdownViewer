'use strict';

// A .docx is a ZIP holding word/document.xml. This walks the ZIP central
// directory, inflates that one entry, and turns the WordprocessingML into DOM
// nodes — no regex over XML, no string of HTML to sanitise.
//
// Fidelity is deliberately partial and the limits are real: paragraphs,
// headings, bold/italic/underline, links, line breaks and bulleted/numbered
// paragraphs render. Tables, images, headers/footers, columns and embedded
// objects do not — a table's cell text appears as consecutive paragraphs.
// This is a reader's view, not Word.
//
// Legacy .doc is a binary OLE2 compound file and is NOT handled here: there
// is no honest way to render it without a real converter, so it goes to the
// OS, which means Word.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const DOCUMENT = 'word/document.xml';

// ZIP64 sentinel: a real 32-bit size never reaches this, but a >4GB entry
// stores 0xFFFFFFFF and the real value in an extra field we do not read.
const ZIP64 = 0xffffffff;

function findEocd(buf) {
	const start = Math.max(0, buf.length - 0xffff - 22);
	for (let i = buf.length - 22; i >= start; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	}
	throw new Error('Not a ZIP archive (no end-of-central-directory record)');
}

function centralEntries(buf) {
	const eocd = findEocd(buf);
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out = new Map();
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`Corrupt central directory at entry ${i}`);
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const usize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		out.set(name, { method, csize, usize, local });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

// Read one entry out of the archive. The local header repeats the name and
// extra lengths, and they can differ from the central ones — the data offset
// must come from the LOCAL header, not the central one.
function readEntry(buf, entry, zlib) {
	if (buf.readUInt32LE(entry.local) !== LOC_SIG) throw new Error('Corrupt local file header');
	const nameLen = buf.readUInt16LE(entry.local + 26);
	const extraLen = buf.readUInt16LE(entry.local + 28);
	const start = entry.local + 30 + nameLen + extraLen;
	if (entry.csize === ZIP64) throw new Error('ZIP64 entry — unsupported');
	const raw = buf.subarray(start, start + entry.csize);
	if (entry.method === 0) return raw;
	if (entry.method === 8) return zlib.inflateRawSync(raw);
	throw new Error(`Unsupported ZIP compression method ${entry.method}`);
}

// WordprocessingML is a flat sea of runs; a paragraph style lives in the
// paragraph's own properties, so the walker carries that state down.
export function docxToFragment(bytes, zlib) {
	const entries = centralEntries(bytes);
	const entry = entries.get(DOCUMENT);
	if (!entry) throw new Error('Not a Word document (no word/document.xml)');

	const xml = readEntry(bytes, entry, zlib).toString('utf8');
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	if (doc.querySelector('parsererror')) throw new Error('word/document.xml is not well-formed XML');

	const body = doc.getElementsByTagName('w:body')[0] || doc.documentElement;
	const frag = document.createDocumentFragment();
	let list = null;

	const val = el => el?.getAttributeNS('http://www.openxmlformats.org/wordprocessingml/2006/main', 'val')
		?? el?.getAttribute('w:val') ?? null;

	for (const p of body.getElementsByTagName('w:p')) {
		if (p.parentNode && p.parentNode.localName === 'txbxContent') continue; // text box
		const pPr = p.getElementsByTagName('w:pPr')[0];
		const style = val(pPr?.getElementsByTagName('w:pStyle')[0]) || '';
		const heading = /^(?:Heading|heading)\s*([1-6])$/.exec(style);
		const numbered = !!pPr?.getElementsByTagName('w:numPr')[0];

		let node;
		if (heading) node = document.createElement('h' + heading[1]);
		else if (numbered) {
			if (!list) {
				list = document.createElement('ul');
				frag.appendChild(list);
			}
			node = document.createElement('li');
		} else {
			node = document.createElement('p');
			list = null;
		}

		for (const r of p.getElementsByTagName('w:r')) {
			const rPr = r.getElementsByTagName('w:rPr')[0];
			const bold = !!rPr?.getElementsByTagName('w:b')[0];
			const italic = !!rPr?.getElementsByTagName('w:i')[0];
			const underline = !!rPr?.getElementsByTagName('w:u')[0];
			let target = node;
			if (bold || italic || underline) {
				const span = document.createElement('span');
				if (bold) span.style.fontWeight = '600';
				if (italic) span.style.fontStyle = 'italic';
				if (underline) span.style.textDecoration = 'underline';
				node.appendChild(span);
				target = span;
			}
			// textContent, never innerHTML: the document is untrusted input.
			for (const t of r.getElementsByTagName('w:t')) target.appendChild(document.createTextNode(t.textContent));
			for (const br of r.getElementsByTagName('w:br')) target.appendChild(document.createElement('br'));
			for (const tab of r.getElementsByTagName('w:tab')) target.appendChild(document.createTextNode('\t'));
		}
		if (node.textContent.trim() || heading) (list || frag).appendChild(node);
	}
	return frag;
}
