'use strict';

// nMarkdownViewer — stage (renderer) logic.
// Browser-first: runs against scripts/serve.js. The Electron shell (SPEC M5)
// provides window.electron_helper and OS integration; all app logic lives here.

import '../modules/nui_wc2/NUI/nui.js';
import { appWindow } from '../modules/nui_wc2/NUI/lib/modules/nui-app-window.js';
import '../modules/nui_wc2/NUI/lib/modules/nui-file-tree.js';
import '../modules/nui_wc2/NUI/lib/modules/nui-rich-text.js';
import { htmlToMarkdown } from './md-serializer.js';
import { createTts } from './tts.js';
import { TtsPlayerHost } from './lib/tts-player.js';

const g = {
	config: null,
	win: null,            // appWindow chrome
	statusBar: null,
	dirHandle: null,      // FileSystemDirectoryHandle backing the tree
	fs: null,             // { readdir, readFileHandle } adapter for the tree root
	fileHandle: null,     // FileSystemFileHandle of the open document
	fileName: '',
	markdown: '',
	frontmatterRaw: null, // fenced YAML block preserved across edit round-trips
	dirty: false,
	mode: 'view',         // 'view' | 'edit'
	tts: null             // config-pane controller (js/tts.js), set in boot
};

const el = {};
for (const id of ['doc-title', 'btn-listen', 'btn-edit', 'btn-save', 'btn-open-folder', 'btn-open-file', 'btn-collapse', 'btn-refresh', 'tree-search', 'file-tree', 'page', 'editor', 'cfg-engine', 'cfg-voice', 'cfg-speed', 'cfg-clean', 'cfg-stitch', 'cfg-status']) {
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

	// Window chrome (title bar + status bar) — same in browser and Electron
	g.win = appWindow({
		title: 'nMarkdownViewer',
		icon: 'article',
		inner: document.getElementById('shell'),
		statusbar: true,
		onClose: () => { window.electron_helper ? electron_helper.app.exit() : location.reload(); }
	});
	g.statusBar = g.win.element.querySelector('.nui-status-bar');
	g.statusBar.innerHTML = '<span id="status-text"></span>';

	// App-level sidebar toggling (data-action="toggle-sidebar[:right]") —
	// a convention the app wires itself, not a NUI builtin (see nui-boilerplate).
	nui.registerAction('toggle-sidebar', (target, el, e, param) => {
		document.querySelector('nui-app')?.toggleSidebar?.(param || 'left');
		return true;
	});

	el['btn-open-folder'].addEventListener('click', openFolder);
	el['btn-open-file'].addEventListener('click', openFile);
	el['btn-refresh'].addEventListener('click', () => el['file-tree'].refresh());
	el['btn-collapse'].addEventListener('click', () => el['file-tree'].collapseAll());
	el['tree-search'].addEventListener('nui-input', (e) => {
		const q = (e.detail?.value ?? el['tree-search'].querySelector('input').value).trim();
		el['file-tree'].filter = q || null;
	});
	el['tree-search'].addEventListener('nui-clear', () => { el['file-tree'].filter = null; });
	el['btn-edit'].addEventListener('click', toggleEdit);
	el['btn-save'].addEventListener('click', writeFile);
	el['btn-listen'].addEventListener('click', listen);

	el['file-tree'].addEventListener('nui-file-select', (e) => onTreeFile(e.detail.entry));
	el['file-tree'].addEventListener('nui-tree-error', (e) => status(`Cannot read ${e.detail.entry.path}: ${e.detail.error}`));

	// Drag & drop (body-level: required for Electron file access later)
	document.body.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
	document.body.addEventListener('drop', onDrop);

	window.addEventListener('beforeunload', (e) => { if (g.dirty) e.preventDefault(); });
	window.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.key === 's') { e.preventDefault(); writeFile(); }
		if (e.ctrlKey && e.key === 'e') { e.preventDefault(); if (g.markdown) toggleEdit(); }
	});

	// TTS config pane + playback
	g.tts = createTts({
		baseUrl: g.config.nspeech.baseUrl,
		elements: { engine: el['cfg-engine'], voice: el['cfg-voice'], speed: el['cfg-speed'], clean: el['cfg-clean'], stitch: el['cfg-stitch'], status: el['cfg-status'] },
		onStatus: status,
		onState: ttsState
	});
	await g.tts.init();

	// Player chrome docked at the bottom of the content area (scrub + download)
	g.playerHost = new TtsPlayerHost({
		controller: g.tts.player,
		mount: document.getElementById('tts-mount'),
		downloadName: () => (g.fileName ? g.fileName.replace(/\.(md|markdown)$/i, '') : 'audio') + '.mp3'
	});
	g.playerHost.attach();

	status(g.tts.available ? 'Ready. Open a folder to begin.' : `nSpeech unreachable at ${g.config.nspeech.baseUrl} — TTS disabled`);

	window.nmdv = g; // dev console access (single-user desktop app)
}

// Sets disabled on BOTH the nui-button wrapper and its inner native button
// (the attribute on the wrapper alone does not gate clicks).
function setBtn(id, disabled) {
	el[id].toggleAttribute('disabled', disabled);
	el[id].querySelector('button').disabled = disabled;
}

// ################################# FILE SYSTEM (browser: File System Access API)

function fsAccessAdapter(rootHandle) {
	const walk = async (path, wantFile) => {
		const segs = path.split('/').filter(Boolean);
		let dir = rootHandle;
		const dirSegs = wantFile ? segs.slice(0, -1) : segs;
		for (const s of dirSegs) dir = await dir.getDirectoryHandle(s);
		return wantFile ? dir.getFileHandle(segs[segs.length - 1]) : dir;
	};
	return {
		async readdir(path) {
			const dir = await walk(path, false);
			const entries = [];
			for await (const child of dir.values()) {
				entries.push({
					name: child.name,
					path: path ? `${path}/${child.name}` : child.name,
					kind: child.kind === 'directory' ? 'dir' : 'file'
				});
			}
			return entries;
		},
		readFileHandle: (path) => walk(path, true)
	};
}

async function openFolder() {
	if (!window.showDirectoryPicker) {
		throw new Error('File System Access API unavailable — use Chrome/Edge or the Electron shell');
	}
	let handle;
	try {
		handle = await window.showDirectoryPicker();
	} catch (err) {
		if (err.name === 'AbortError') return; // user cancelled — normal variance
		throw err;
	}
	g.dirHandle = handle;
	g.fs = fsAccessAdapter(handle);
	const tree = el['file-tree'];
	tree.setProvider(g.fs.readdir);
	await tree.setRoot({ name: handle.name, path: '' });
	setBtn('btn-refresh', false);
	setBtn('btn-collapse', false);
	status(`Folder: ${handle.name}`);
}

async function onTreeFile(entry) {
	if (entry.kind === 'dir') return;
	if (!/\.(md|markdown)$/i.test(entry.name)) {
		status(`${entry.name} is not a Markdown file.`);
		return;
	}
	if (entry.path === g.fileHandle?._nmdvPath) return;
	if (!await confirmDiscard()) {
		if (g.fileHandle?._nmdvPath) el['file-tree'].select(g.fileHandle._nmdvPath);
		return;
	}
	const handle = await g.fs.readFileHandle(entry.path);
	handle._nmdvPath = entry.path;
	const file = await handle.getFile();
	loadDocument(handle, file.name, await file.text());
}

async function openFile() {
	if (!window.showOpenFilePicker) {
		throw new Error('File System Access API unavailable — use Chrome/Edge or the Electron shell');
	}
	if (!await confirmDiscard()) return;
	let handle;
	try {
		[handle] = await window.showOpenFilePicker({
			types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
		});
	} catch (err) {
		if (err.name === 'AbortError') return;
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
	if (!await confirmDiscard()) return;
	const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
	loadDocument(handle, file.name, await file.text());
}

// Returns true when it is safe to replace the current document.
async function confirmDiscard() {
	if (!g.dirty) return true;
	if (g.mode === 'edit') applyEdit(); // serialize pending edits before deciding
	return await nui.components.dialog.confirm(
		'Unsaved changes',
		`"${g.fileName}" has unsaved changes. Discard them?`
	);
}

// ################################# DOCUMENT

function loadDocument(handle, name, text) {
	g.tts?.stop();
	g.fileHandle = handle;
	g.fileName = name;
	g.markdown = text;
	g.dirty = false;
	setMode('view');
	renderView();
	document.getElementById('md-main').scrollTop = 0; // new document starts at the top
	setTitle(name);
	setBtn('btn-edit', false);
	setBtn('btn-save', false);
	setBtn('btn-listen', !g.tts?.available);
	status(`Opened ${name} (${text.length} chars)`);
}

async function writeFile() {
	if (!g.markdown && !g.fileHandle) return;
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
	setTitle(g.fileName);
	status(`Saved ${g.fileHandle.name}`);
}

// ################################# VIEW / EDIT

function setMode(mode) {
	g.mode = mode;
	const viewer = document.getElementById('viewer');
	if (viewer) viewer.hidden = mode === 'edit';
	const welcome = document.getElementById('welcome');
	if (welcome) welcome.hidden = mode === 'edit';
	el.editor.hidden = mode !== 'edit';
	el['btn-edit'].querySelector('button').setAttribute('aria-label', mode === 'edit' ? 'Preview' : 'Edit');
	el['btn-edit'].querySelector('nui-icon').setAttribute('name', mode === 'edit' ? 'visibility' : 'edit');
}

function renderView() {
	// nui-markdown renders once on connect (_processed guard) — swap in a
	// fresh element instead of mutating the connected one.
	document.getElementById('viewer')?.remove();
	const welcome = document.getElementById('welcome');
	if (welcome) welcome.remove();
	const viewer = document.createElement('nui-markdown');
	viewer.id = 'viewer';
	viewer.setAttribute('frontmatter', 'show');
	const s = document.createElement('script');
	s.type = 'text/markdown';
	s.textContent = g.markdown;
	viewer.appendChild(s);
	el.page.appendChild(viewer);
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
	if (!g.dirty) {
		g.dirty = true;
		setTitle(g.fileName);
	}
	setMode('view');
	renderView();
	status('Edits applied (unsaved)');
}

function setTitle(name) {
	const label = name + (g.dirty ? '' : '');
	el['doc-title'].textContent = label;
	el['doc-title'].classList.toggle('dirty', g.dirty);
	g.win.element.querySelector('.nui-app-titlebar .label').textContent = (g.dirty ? '• ' : '') + (name || 'nMarkdownViewer');
}

// ################################# TTS (nSpeech v3, config pane + SpeechPlayer)

function listen() {
	if (g.mode === 'edit') applyEdit();
	const fm = nui.util.parseFrontmatter(g.markdown);
	const text = (fm ? fm.content : g.markdown).trim();
	if (!text) { status('Nothing to speak.'); return; }
	g.tts.speak(text);
}

// Player state → listen button icon (transport itself lives in the docked player)
function ttsState(state) {
	const icon = el['btn-listen'].querySelector('nui-icon');
	switch (state) {
		case 'loading': icon.setAttribute('name', 'close'); break;
		case 'playing': icon.setAttribute('name', 'pause'); break;
		case 'paused': icon.setAttribute('name', 'play'); break;
		case 'idle': icon.setAttribute('name', 'volume'); break;
	}
}

// ################################# MISC

function status(msg) {
	const t = document.getElementById('status-text');
	if (t) t.textContent = msg;
	console.log('[nMDV]', msg);
}
