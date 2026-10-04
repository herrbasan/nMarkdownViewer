'use strict';

// Extension → what the viewer does with the file. ONE table, consulted by the
// tree, the OS handoff, the drop handler and link routing, so a file reached
// four different ways is rendered the same way every time.
//
// A kind of `null` means "not ours" — the OS opens it, exactly as before this
// table existed. Anything a browser would render is here; what a browser
// renders through a plugin (PDF) is deliberately NOT, because Chromium's
// viewer cannot be embedded and goes to the OS handler instead.

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg']);

const VIDEO = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv']);
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus']);

// Read-only text. `lang` is the highlighter dialect: the five NUI ships
// (html/xml, css, js, ts, json) plus the ones app/js/highlight.js adds.
// Everything else stays escaped plain text rather than mis-coloured.
const TEXT = {
	'.txt': '', '.log': '', '.csv': '', '.tsv': '', '.env': '', '.lock': '',
	'.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini',
	'.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.kt': 'kotlin', '.swift': '',
	'.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
	'.cs': 'cs', '.php': 'php', '.py': 'py', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'ps1',
	'.sql': 'sql', '.diff': 'diff', '.patch': 'diff',
	'.md': '', '.markdown': '',
	// JSON Lines: one object per line. Not valid JSON as a whole, but every
	// value is, and the token rules are per-value.
	'.jsonl': 'json', '.ndjson': 'json',
	'.json': 'json', '.jsonc': 'json',
	'.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
	'.ts': 'ts', '.tsx': 'ts',
	'.css': 'css', '.scss': '', '.less': '',
	'.editorconfig': '', '.npmrc': '', '.gitignore': ''
};

// A PDF is rendered by pdf.js (app/js/pdf-view.js) — a RENDERER, not a
// browser plugin, which is why it works when Chromium's own viewer does not.
// That viewer is gated on webPreferences.plugins (default false) and its bundle
// additionally fails to start in Electron 41, so <embed>/<iframe>/<object>/
// <webview> were each measured and none of them paint.
const PDF = new Set(['.pdf']);

// A .docx is unpacked and converted. Legacy .doc is a binary OLE2 compound
// file — there is no honest way to render it without a converter, so it stays
// `null` and the OS (i.e. Word) opens it, which is the right answer anyway.
const DOCX = new Set(['.docx']);
const MARKUP = new Set(['.html', '.htm', '.xhtml', '.xml']);

function extOf(name) {
	const i = String(name).lastIndexOf('.');
	return i <= 0 ? '' : String(name).slice(i).toLowerCase();
}

// 'markdown' | 'image' | 'video' | 'audio' | 'text' | 'html' | 'pdf' | 'docx' | null
export function kindOf(name) {
	const ext = extOf(name);
	if (ext === '.md' || ext === '.markdown') return 'markdown';
	if (MARKUP.has(ext)) return 'html';
	if (IMAGE.has(ext)) return 'image';
	if (VIDEO.has(ext)) return 'video';
	if (AUDIO.has(ext)) return 'audio';
	if (ext in TEXT) return 'text';
	if (PDF.has(ext)) return 'pdf';
	if (DOCX.has(ext)) return 'docx';
	return null;
}

// The dialects NUI's own highlighter owns. Anything else that has a dialect
// is app-side (see app/js/highlight.js) — splitting it here keeps the
// component from being handed a language it would silently render as plain.
export const NUI_LANGS = new Set(['html', 'xml', 'css', 'js', 'javascript', 'ts', 'typescript', 'json', 'txt', '']);

// The highlighter dialect for a text file, or '' for plain.
export function langOf(name) {
	return TEXT[extOf(name)] ?? '';
}

// Every kind the viewer can put on screen itself. A `.md` link and a `.png`
// link both open a viewer window; anything else goes to the OS.
export function isDisplayable(name) {
	return kindOf(name) !== null;
}

// The kinds whose bytes are decoded as text. Everything else is served to a
// media element by URL and is never read into the renderer.
export function isTextual(name) {
	const k = kindOf(name);
	return k === 'markdown' || k === 'text';
}
