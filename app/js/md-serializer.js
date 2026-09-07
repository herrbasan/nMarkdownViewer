'use strict';

// HTML → Markdown serializer for the subset produced by nui-rich-text.
// Inverse of nui.util.markdownToHtml. DOM-walking, zero dependencies.
// Input: Element or HTML string. Output: Markdown source (LF endings).

const BLOCK_TAGS = new Set([
	'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
	'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
	'HEADER', 'HR', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL'
]);

export function htmlToMarkdown(input) {
	const root = typeof input === 'string'
		? new DOMParser().parseFromString(input, 'text/html').body
		: input;
	if (!root) throw new Error('htmlToMarkdown: no input');
	return serializeBlocks(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isBlock(node) {
	return node.nodeType === 1 && BLOCK_TAGS.has(node.tagName);
}

function serializeBlocks(parent) {
	let out = '';
	for (const child of parent.childNodes) {
		if (child.nodeType === 3) {
			const t = child.textContent.trim();
			if (t) out += escapeText(t) + '\n\n';
			continue;
		}
		if (child.nodeType !== 1) continue;
		out += serializeBlock(child);
	}
	return out;
}

function serializeBlock(el) {
	const tag = el.tagName;

	if (/^H[1-6]$/.test(tag)) {
		return '#'.repeat(Number(tag[1])) + ' ' + serializeInlineChildren(el).trim() + '\n\n';
	}
	if (tag === 'HR') return '---\n\n';
	if (tag === 'BLOCKQUOTE') {
		const inner = serializeBlocks(el).trim();
		return inner.split('\n').map(l => l ? '> ' + l : '>').join('\n') + '\n\n';
	}
	if (tag === 'UL' || tag === 'OL') return serializeList(el, 0) + '\n';
	if (tag === 'PRE') {
		const code = el.querySelector('code');
		const lang = (code?.dataset.lang || '').trim();
		const text = (code || el).textContent.replace(/\n$/, '');
		return '```' + lang + '\n' + text + '\n```\n\n';
	}
	if (tag === 'TABLE') return serializeTable(el) + '\n';
	if (tag === 'P' || tag === 'DIV' || isBlock(el)) {
		// Mixed content: block children recurse, inline runs become paragraphs.
		if ([...el.childNodes].some(isBlock)) return serializeBlocks(el);
		const line = serializeInlineChildren(el).trim();
		return line ? line + '\n\n' : '';
	}
	// Inline element at block level (e.g. stray <b>) — wrap as paragraph.
	const line = serializeInline(el).trim();
	return line ? line + '\n\n' : '';
}

function serializeList(el, depth) {
	const ordered = el.tagName === 'OL';
	const indent = '\t'.repeat(depth);
	let out = '';
	let i = 0;
	for (const li of el.children) {
		if (li.tagName !== 'LI') continue;
		i++;
		const marker = ordered ? `${i}. ` : '- ';
		let text = '';
		let nested = '';
		for (const child of li.childNodes) {
			if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
				nested += serializeList(child, depth + 1);
			} else if (isBlock(child)) {
				const block = serializeBlock(child).trim();
				if (block) text += (text ? ' ' : '') + block;
			} else {
				text += serializeInline(child);
			}
		}
		out += indent + marker + text.trim() + '\n';
		if (nested) out += nested;
	}
	return out;
}

function serializeTable(table) {
	const rows = [...table.querySelectorAll('tr')];
	if (!rows.length) return '';
	const cellText = (cell) => serializeInlineChildren(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const grid = rows.map(r => [...r.querySelectorAll('th,td')].map(cellText));
	const cols = Math.max(...grid.map(r => r.length));
	for (const r of grid) while (r.length < cols) r.push('');
	const line = (r) => '| ' + r.join(' | ') + ' |';
	const sep = '| ' + Array(cols).fill('---').join(' | ') + ' |';
	return [line(grid[0]), sep, ...grid.slice(1).map(line)].join('\n') + '\n\n';
}

function serializeInlineChildren(el) {
	return [...el.childNodes].map(serializeInline).join('');
}

function serializeInline(node) {
	if (node.nodeType === 3) return escapeText(node.textContent);
	if (node.nodeType !== 1) return '';

	const tag = node.tagName;
	const inner = () => serializeInlineChildren(node);

	switch (tag) {
		case 'STRONG':
		case 'B': return wrap('**', inner());
		case 'EM':
		case 'I': return wrap('*', inner());
		case 'S':
		case 'STRIKE':
		case 'DEL': return wrap('~~', inner());
		case 'CODE': {
			if (node.closest('pre')) return node.textContent; // handled by PRE
			const t = node.textContent;
			const fence = t.includes('`') ? '``' : '`';
			return fence + t + fence;
		}
		case 'A': {
			const href = node.getAttribute('href') || '';
			const text = inner().trim() || href;
			return `[${text}](${href})`;
		}
		case 'IMG': {
			const alt = node.getAttribute('alt') || '';
			const src = node.getAttribute('src') || '';
			return `![${alt}](${src})`;
		}
		case 'BR': return '  \n';
		case 'U': return `<u>${inner()}</u>`; // no Markdown underline — keep HTML
		case 'SCRIPT': return ''; // never serialize script/style payloads
		case 'STYLE': return '';
		default:
			// Block elements nested in inline context (invalid HTML, but be loud-tolerant)
			if (isBlock(node)) return '\n\n' + serializeBlock(node).trim() + '\n\n';
			return inner();
	}
}

function wrap(marker, text) {
	const t = text.trim();
	if (!t) return '';
	return marker + t + marker;
}

// Escape the minimum set so round-tripped text survives markdownToHtml.
function escapeText(t) {
	return t.replace(/([\\`*_[\]])/g, '\\$1');
}
