'use strict';

// nMarkdownViewer — stage (renderer) logic.
// Browser-first: runs against scripts/serve.js. The Electron shell (SPEC M5)
// provides window.electron_helper and OS integration; all app logic lives here.

import '../modules/nui_wc2/NUI/nui.js';
import '../modules/nui_wc2/NUI/lib/modules/nui-rich-text.js';
import { htmlToMarkdown } from './md-serializer.js';

const g = {
	config: null,
	fileHandle: null,
	fileName: '',
	markdown: '',
	frontmatterRaw: null, // fenced YAML block preserved across edit round-trips
	dirty: false,
	mode: 'view', // 'view' | 'edit'
	nspeechOk: false,
	tts: { chunks: [], index: 0, playing: false, audio: null }
};

const el = {};
for (const id of ['btn-open', 'btn-edit', 'btn-save', 'btn-listen', 'btn-stop', 'voice-select', 'editor', 'file-label', 'status', 'content']) {
	el[id] = document.getElementById(id);
}

boot().catch(err => {
	status(`FATAL: ${err.message}`);
	throw err;
});

async function boot() {
	if (window.electron_helper) {
		throw new Error('Electron shell not implemented yet — see docs/nMarkdownViewer_SPEC.md M5');
	}

	const res = await fetch('../config.json');
	if (!res.ok) throw new Error(`config.json unreachable (${res.status}) — run via scripts/serve.js`);
	g.config = await res.json();

	el['btn-open'].addEventListener('click', openFile);
	el['btn-edit'].addEventListener('click', toggleEdit);
	el['btn-save'].addEventListener('click', writeFile);
	el['btn-listen'].addEventListener('click', listen);
	el['btn-stop'].addEventListener('click', stopTts);

	// Drag & drop (body-level: required for Electron file access later)
	document.body.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
	document.body.addEventListener('drop', onDrop);

	window.addEventListener('beforeunload', (e) => { if (g.dirty) e.preventDefault(); });

	g.tts.audio = new Audio();
	g.tts.audio.addEventListener('ended', nextChunk);
	g.tts.audio.addEventListener('error', () => {
		status(`TTS playback error on chunk ${g.tts.index + 1}`);
		stopTts();
	});

	await checkNspeech();
	status('Ready.');
}

// ################################# FILES

async function openFile() {
	if (!window.showOpenFilePicker) {
		throw new Error('File System Access API unavailable — use Chrome/Edge or the Electron shell');
	}
	let handle;
	try {
		[handle] = await window.showOpenFilePicker({
			types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
		});
	} catch (err) {
		if (err.name === 'AbortError') return; // user cancelled — normal variance
		throw err;
	}
	const file = await handle.getFile();
	loadDocument(handle, file.name, await file.text());
}

async function onDrop(e) {
	e.preventDefault();
	const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
	if (!item) return;
	const file = item.getAsFile();
	if (!file || !/\.(md|markdown)$/i.test(file.name)) {
		status('Drop ignored: not a Markdown file.');
		return;
	}
	const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
	loadDocument(handle, file.name, await file.text());
}

function loadDocument(handle, name, text) {
	stopTts();
	g.fileHandle = handle;
	g.fileName = name;
	g.markdown = text;
	g.dirty = false;
	setMode('view');
	renderView();
	el['file-label'].textContent = name;
	el['btn-edit'].disabled = false;
	el['btn-save'].disabled = false;
	el['btn-listen'].disabled = !g.nspeechOk;
	status(`Opened ${name} (${text.length} chars)`);
}

async function writeFile() {
	if (g.mode === 'edit') applyEdit();
	if (!g.fileHandle) {
		try {
			g.fileHandle = await window.showSaveFilePicker({
				suggestedName: g.fileName || 'document.md',
				types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
			});
		} catch (err) {
			if (err.name === 'AbortError') return;
			throw err;
		}
	}
	const w = await g.fileHandle.createWritable();
	await w.write(g.markdown);
	await w.close();
	g.dirty = false;
	status(`Saved ${g.fileHandle.name}`);
}

// ################################# VIEW / EDIT

function setMode(mode) {
	g.mode = mode;
	const viewer = document.getElementById('viewer');
	if (viewer) viewer.hidden = mode === 'edit';
	el.editor.hidden = mode !== 'edit';
	el['btn-edit'].querySelector('button').textContent = mode === 'edit' ? 'Preview' : 'Edit';
}

function renderView() {
	// nui-markdown renders once on connect (_processed guard) — swap in a
	// fresh element instead of mutating the connected one.
	const old = document.getElementById('viewer');
	const viewer = document.createElement('nui-markdown');
	viewer.id = 'viewer';
	viewer.setAttribute('frontmatter', 'show');
	const s = document.createElement('script');
	s.type = 'text/markdown';
	s.textContent = g.markdown;
	viewer.appendChild(s);
	if (old) old.replaceWith(viewer);
	else el.content.appendChild(viewer);
}

function toggleEdit() {
	if (g.mode === 'view') enterEdit();
	else applyEdit();
}

function enterEdit() {
	const fm = nui.util.parseFrontmatter(g.markdown);
	g.frontmatterRaw = fm ? fm.raw : null;
	const body = fm ? fm.content : g.markdown;
	el.editor.value = nui.util.markdownToHtml(body, { frontmatter: false });
	setMode('edit');
}

function applyEdit() {
	const body = htmlToMarkdown(el.editor.value);
	g.markdown = g.frontmatterRaw ? g.frontmatterRaw + '\n\n' + body : body;
	g.frontmatterRaw = null;
	g.dirty = true;
	setMode('view');
	renderView();
	status('Edits applied (unsaved)');
}

// ################################# TTS (nSpeech)

async function checkNspeech() {
	const base = g.config.nspeech.baseUrl;
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		g.nspeechOk = true;
		await loadVoices();
	} catch (err) {
		g.nspeechOk = false;
		el['btn-listen'].disabled = true;
		status(`nSpeech unreachable at ${base} — TTS disabled (${err.message})`);
	}
}

async function loadVoices() {
	const base = g.config.nspeech.baseUrl;
	const res = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`/voices HTTP ${res.status}`);
	const data = await res.json();
	const select = el['voice-select'].querySelector('select');
	select.replaceChildren();
	const def = new Option('default voice', '');
	select.add(def);
	for (const v of data.voices || []) select.add(new Option(v.name, v.name));
	if (g.config.nspeech.voice) select.value = g.config.nspeech.voice;
}

function listen() {
	if (g.mode === 'edit') applyEdit();
	g.tts.chunks = buildChunks(markdownToText(g.markdown));
	if (!g.tts.chunks.length) { status('Nothing to speak.'); return; }
	g.tts.index = 0;
	g.tts.playing = true;
	el['btn-stop'].disabled = false;
	playChunk();
}

function playChunk() {
	const t = g.tts;
	if (t.index >= t.chunks.length) { stopTts(); status('Playback finished.'); return; }
	const cfg = g.config.nspeech;
	const params = new URLSearchParams({ text: t.chunks[t.index], output_format: cfg.outputFormat });
	const voice = el['voice-select'].querySelector('select').value;
	if (voice) params.set('voice_name', voice);
	t.audio.src = `${cfg.baseUrl}/tts?${params}`;
	t.audio.play();
	el['btn-listen'].disabled = true;
	status(`Speaking ${t.index + 1}/${t.chunks.length}`);
}

function nextChunk() {
	g.tts.index++;
	playChunk();
}

function stopTts() {
	const t = g.tts;
	t.audio.pause();
	t.audio.removeAttribute('src');
	t.audio.load();
	t.playing = false;
	t.chunks = [];
	t.index = 0;
	el['btn-stop'].disabled = true;
	el['btn-listen'].disabled = !g.nspeechOk || !g.markdown;
}

// Plain-text extraction from Markdown source (deterministic, no DOM).
function markdownToText(md) {
	const fm = nui.util.parseFrontmatter(md);
	let t = fm ? fm.content : md;
	t = t
		.replace(/```[\s\S]*?```/g, ' ')          // fenced code
		.replace(/`([^`]*)`/g, '$1')              // inline code
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → text
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')       // headings
		.replace(/^\s*[-*+]\s+/gm, '')            // list markers
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')                // blockquotes
		.replace(/^\s*\|.*\|\s*$/gm, ' ')         // tables
		.replace(/(\*\*|__)(.*?)\1/g, '$2')       // bold
		.replace(/(\*|_)(.*?)\1/g, '$2')          // italic
		.replace(/~~(.*?)~~/g, '$1')              // strike
		.replace(/<[^>]+>/g, ' ')                 // stray HTML
		.replace(/\\([\\`*_[\]])/g, '$1')         // escapes
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n');
	return t.trim();
}

// Sentence-aware chunking: pack sentences up to maxChunkChars,
// hard-split oversize sentences at the last space.
function buildChunks(text) {
	const max = g.config.nspeech.maxChunkChars;
	const sentences = text.match(/[^.!?…\n]+[.!?…]*\s*/g) || [];
	const chunks = [];
	let cur = '';
	for (const s of sentences) {
		if (s.length > max) {
			if (cur) { chunks.push(cur.trim()); cur = ''; }
			let rest = s;
			while (rest.length > max) {
				let cut = rest.lastIndexOf(' ', max);
				if (cut < max / 2) cut = max;
				chunks.push(rest.slice(0, cut).trim());
				rest = rest.slice(cut);
			}
			cur = rest;
			continue;
		}
		if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = ''; }
		cur += s;
	}
	if (cur.trim()) chunks.push(cur.trim());
	return chunks;
}

// ################################# MISC

function status(msg) {
	el.status.textContent = msg;
	console.log('[nMDV]', msg);
}
