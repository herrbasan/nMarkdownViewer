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

// Read-only text. `lang` is NUI's highlighter dialect, which knows exactly
// five languages; everything else stays escaped plain text rather than
// mis-coloured. Empty string = no highlighting.
const TEXT = {
	'.txt': '', '.log': '', '.csv': '', '.tsv': '', '.env': '', '.lock': '',
	'.yml': '', '.yaml': '', '.toml': '', '.ini': '', '.cfg': '', '.conf': '',
	'.py': '', '.rb': '', '.go': '', '.rs': '', '.java': '', '.kt': '', '.swift': '',
	'.c': '', '.h': '', '.cpp': '', '.hpp': '', '.cs': '', '.php': '', '.pl': '',
	'.sh': '', '.bash': '', '.ps1': '', '.bat': '', '.cmd': '', '.sql': '',
	'.json': 'json', '.jsonc': 'json',
	'.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
	'.ts': 'ts', '.tsx': 'ts',
	'.css': 'css', '.scss': '', '.less': '',
	'.editorconfig': '', '.npmrc': '', '.gitignore': ''
};

// HTML and XML are rendered, not shown as source — but never in this window's
// own document; see the iframe note in renderAsset().
const MARKUP = new Set(['.html', '.htm', '.xhtml', '.xml']);

function extOf(name) {
	const i = String(name).lastIndexOf('.');
	return i <= 0 ? '' : String(name).slice(i).toLowerCase();
}

// 'markdown' | 'image' | 'video' | 'audio' | 'text' | 'html' | null
export function kindOf(name) {
	const ext = extOf(name);
	if (ext === '.md' || ext === '.markdown') return 'markdown';
	if (MARKUP.has(ext)) return 'html';
	if (IMAGE.has(ext)) return 'image';
	if (VIDEO.has(ext)) return 'video';
	if (AUDIO.has(ext)) return 'audio';
	if (ext in TEXT) return 'text';
	return null;
}

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
