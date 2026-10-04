'use strict';

// Syntax highlighting for the languages NUI's highlighter does not know.
//
// nui-syntax-highlight.js ships five dialects — html/xml, css, js, ts, json —
// and returns escaped PLAIN TEXT for anything else, which is why a .php file
// showed no colour at all rather than slightly wrong colour.
//
// This adds the common server/scripting languages. It emits the SAME hl-*
// class names the addon uses, so the one stylesheet covers both and the two
// cannot drift apart visually. Anything not listed here is not highlighted —
// and `highlightCode` returns null so the caller can say so rather than
// inventing tokens for a language it does not know.
//
// The tokenizer is deliberately small: comments, strings, numbers, keywords,
// calls, and the one sigil that matters per language (PHP's $, shell's $,
// Python's @decorator). It is a reader's highlighter, not a compiler's.

const C_KEYWORDS = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';
const C_TYPES = 'bool byte size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t string vector map set pair tuple';

const LANGS = {
	php: {
		block: [['/*', '*/']], line: ['//', '#'],
		strings: ['"', "'"],
		keywords: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
		literals: 'true false null TRUE FALSE NULL',
		sigil: /\$[A-Za-z_]\w*/g
	},
	python: {
		line: ['#'],
		strings: ['"', "'"],
		keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
		literals: 'True False None self cls',
		sigil: /@[A-Za-z_][\w.]*/g
	},
	sh: {
		line: ['#'],
		strings: ['"', "'"],
		keywords: 'if then else elif fi case esac for while until do done in function select time coproc return break continue local export readonly declare source alias unset shift trap set',
		literals: 'true false',
		sigil: /\$[A-Za-z_]\w*|\$\{[^}]*\}|\$\([^)]*\)|\$\?|\$@|\$!|\$\d/g
	},
	ps1: {
		line: ['#'],
		strings: ['"', "'"],
		keywords: 'if else elseif switch foreach for while do until break continue return function filter workflow param begin process try catch finally throw using',
		literals: 'true false null',
		sigil: /\$[A-Za-z_]\w*(?::[\w-]+)?/g
	},
	sql: {
		block: [['/*', '*/']], line: ['--'],
		strings: ["'"],
		keywords: 'select from where group by having order limit offset insert into values update set delete create alter drop table index view join inner left right outer full on as and or not null primary key foreign references default unique check constraint cascade truncate begin commit rollback with returning distinct union all exists in between like ilike is asc desc',
		literals: 'true false',
		numbers: /\b\d+(?:\.\d+)?\b/g
	},
	c: { block: [['/*', '*/']], line: ['//'], strings: ['"', "'"], keywords: C_KEYWORDS, types: C_TYPES, sigil: /#\s*[A-Za-z_]\w*/g },
	cpp: { block: [['/*', '*/']], line: ['//'], strings: ['"', "'"], keywords: C_KEYWORDS + ' class namespace template typename public private protected virtual override new delete this using try catch throw constexpr nullptr auto friend operator explicit mutable', types: C_TYPES + ' string vector map set' },
	java: { block: [['/*', '*/']], line: ['//'], strings: ['"', "'"], keywords: C_KEYWORDS + ' class interface extends implements package import public private protected abstract final native synchronized throws instanceof super this new enum record sealed permits', types: C_TYPES + ' String List Map Set Optional' },
	cs: { block: [['/*', '*/']], line: ['//'], strings: ['"'], keywords: C_KEYWORDS + ' class namespace using public private protected internal static readonly abstract virtual override sealed partial async await var record event delegate get set where is new this base value', types: C_TYPES + ' string List Dictionary Task' },
	go: { block: [['/*', '*/']], line: ['//'], strings: ['"', "'", '`'], keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var', literals: 'true false nil iota', types: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr' },
	rust: { block: [['/*', '*/']], line: ['//'], strings: ['"'], keywords: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while union', literals: 'true false None Some Ok Err', types: 'bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize Vec Option Result' },
	ruby: { block: [['=begin', '=end']], line: ['#'], strings: ['"', "'"], keywords: 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer puts', literals: 'true false nil', sigil: /[@$][A-Za-z_]\w*/g },
	yaml: { line: ['#'], strings: ['"', "'"], keys: true, literals: 'true false null yes no on off' },
	ini: { line: ['#', ';'], strings: ['"', "'"], keys: true, literals: 'true false' },
	diff: { line: [], block: [], diff: true }
};

// Same order the addon uses, so a file that IS supported keeps the library's
// own output and never touches this path.
function escapeHtml(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RE_KEYWORD = (words) => new RegExp('\\b(' + words.trim().split(/\s+/).join('|') + ')\\b', 'g');
const RE_CALL = /\b([A-Za-z_]\w*)(?=\s*\()/g;
const RE_NUMBER = /\b(0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g;
const RE_PHP_VAR = /\$[A-Za-z_]\w*/g;
const RE_PY_DECORATOR = /@[A-Za-z_][\w.]*/g;

// Escapes first, then matches on the escaped text — the same discipline the
// addon uses, so `&lt;?php` is a tag and never a comparison operator.
export function highlightCode(code, lang) {
	const spec = LANGS[lang];
	if (!spec) return null;

	const tokens = [];
	const hold = (cls, text) => {
		const t = '~~NMDV' + tokens.length + '~~';
		tokens.push({ t, h: `<span class="hl-${cls}">${text}</span>` });
		return t;
	};
	let html = escapeHtml(code);

	if (spec.diff) return diffPass(html, hold, escapeHtml);

	// Comments before anything else: a quote inside a comment is not a string.
	for (const [open, close] of spec.block || []) {
		const re = new RegExp(escapeRe(open) + '[\\s\\S]*?' + escapeRe(close), 'g');
		html = html.replace(re, m => hold('comment', m));
	}
	for (const marker of spec.line || []) {
		const re = new RegExp('^.*?' + escapeRe(marker) + '.*$', 'gm');
		html = html.replace(re, m => hold('comment', m));
	}
	for (const q of spec.strings) {
		const re = new RegExp(escapeRe(q) + '(?:[^' + (q === "'" ? "'" : q) + '\\\\]|\\\\.)*' + escapeRe(q) + '?', 'g');
		html = html.replace(re, m => hold('string', m));
	}
	if (spec.numbers) html = html.replace(spec.numbers, m => hold('number', m));
	else html = html.replace(RE_NUMBER, m => hold('number', m));

	if (spec.literals) html = html.replace(RE_KEYWORD(spec.literals), m => hold('literal', m));
	if (spec.types) html = html.replace(RE_KEYWORD(spec.types), m => hold('type', m));
	if (spec.keywords) html = html.replace(RE_KEYWORD(spec.keywords), m => hold('keyword', m));
	if (spec.sigil === RE_PHP_VAR || spec.sigil === RE_PY_DECORATOR) {
		html = html.replace(spec.sigil, m => hold('variable', m));
	} else if (spec.sigil) {
		html = html.replace(spec.sigil, m => hold('variable', m));
	}
	if (spec.keys) {
		// YAML/INI: a bare key before the first = or : on the line.
		html = html.replace(/^([ \t-]*)([\w.$-]+)(?=\s*[:=])/gm, (m, ws, k) => ws + hold('attr', k));
	}
	html = html.replace(RE_CALL, m => hold('function', m));

	return resolve(html, tokens);
}

function diffPass(html, hold, esc) {
	// Line-based, on the raw source, so the +/-/@@ markers are never mistaken
	// for operators by the generic passes.
	return html.split('\n').map(line => {
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return hold('meta', line);
		if (line.startsWith('+')) return hold('add', line);
		if (line.startsWith('-')) return hold('del', line);
		return line;
	}).join('\n');
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolve(html, tokens) {
	let pass = 0;
	while (html.includes('~~NMDV') && pass < 10) {
		html = html.replace(/~~NMDV(\d+)~~/g, (m, id) => (tokens[id] ? tokens[id].h : m));
		pass++;
	}
	return html;
}

export const supportedLanguages = Object.keys(LANGS);
