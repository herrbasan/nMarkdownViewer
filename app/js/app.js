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
import { prefs } from './prefs.js';
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
for (const id of ['doc-title', 'btn-listen', 'btn-edit', 'btn-save', 'btn-open-folder', 'btn-open-file', 'btn-collapse', 'btn-refresh', 'tree-search', 'file-tree', 'page', 'editor', 'cfg-engine', 'cfg-model', 'cfg-model-wrap', 'cfg-voice', 'cfg-speed', 'cfg-clean', 'cfg-stitch', 'cfg-status', 'cfg-startup', 'btn-startup-choose', 'btn-startup-clear', 'startup-path']) {
	el[id] = document.getElementById(id);
}

boot().catch(err => {
	status(`FATAL: ${err.message}`);
	throw err;
});

async function boot() {
	if (window.electron_helper) await bootElectron();
	else await bootBrowser();

	// Persistent prefs BEFORE anything reads them (TTS, startup folder).
	// Electron: prefs.json in userData; browser: localStorage.
	await prefs.init(g.mainEnv?.userData);

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
	el['btn-startup-choose'].addEventListener('click', chooseStartupDir);
	el['btn-startup-clear'].addEventListener('click', clearStartupDir);
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

	nui.util.setMarkdownImageRewrite(resolveImageUri);

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
		elements: { engine: el['cfg-engine'], model: el['cfg-model'], modelWrap: el['cfg-model-wrap'], voice: el['cfg-voice'], speed: el['cfg-speed'], clean: el['cfg-clean'], stitch: el['cfg-stitch'], status: el['cfg-status'] },
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

	// OS-opened file (double-click / CLI arg): root the tree at its folder, open it
	if (g.mainEnv?.filePath) {
		await rootTree(
			{ name: g.npath.basename(g.npath.dirname(g.mainEnv.filePath)), fs: nativeFsAdapter(), rootPath: g.npath.dirname(g.mainEnv.filePath) },
			g.mainEnv.filePath
		);
	} else if (g.mainEnv) {
		// No file attached: fall back to the persisted startup folder (if any).
		// A missing dir (unmounted drive, renamed) is a visible no-op, not a
		// crash — the pref survives so a remounted drive works again.
		const dir = prefs.get('startupDir');
		if (dir) {
			try {
				const st = await g.nfs.stat(dir);
				if (!st.isDirectory()) throw new Error('not a directory');
				await rootTree({ name: g.npath.basename(dir), fs: nativeFsAdapter(), rootPath: dir });
				await openFirstMarkdown();
			} catch (err) {
				status(`Startup folder unavailable: ${dir} (${err.message})`);
			}
		}
		updateStartupUi();
	}

	status(g.tts.available ? 'Ready. Open a folder to begin.' : `nSpeech unreachable at ${g.config.nspeech.baseUrl} — TTS disabled`);

	// Dev-only boot beacon: lets smoke tests verify Electron boots headlessly
	if (g.mainEnv && !g.mainEnv.isPackaged) {
		const out = g.npath.join(g.mainEnv.app_path, 'out');
		await g.nfs.mkdir(out, { recursive: true });
		await g.nfs.writeFile(g.npath.join(out, 'boot-beacon.json'), JSON.stringify({
			filePath: g.mainEnv.filePath,
			docLoaded: g.fileName,
			treeRoot: g.fs ? 'set' : null,
			treeNodes: el['file-tree']._nodes?.size ?? 0,
			ttsAvailable: g.tts.available,
			status: document.getElementById('status-text').textContent
		}, null, 2));
	}

	window.nmdv = g; // dev console access (single-user desktop app)
}

async function bootBrowser() {
	const res = await fetch('../config.json');
	if (!res.ok) throw new Error(`config.json unreachable (${res.status}) — run via scripts/serve.js`);
	g.config = await res.json();
}

async function bootElectron() {
	document.body.classList.add('electron'); // hides Open File (OS provides it)
	el['cfg-startup'].hidden = false; // startup folder is Electron-only
	g.mainEnv = await electron_helper.global.get('env');
	g.npath = window.nmdv_node.path;
	g.nfs = window.nmdv_node.fsp;
	g.fsSync = window.nmdv_node.fs;
	const fp = g.mainEnv.isPackaged ? g.npath.dirname(g.mainEnv.app_path) : g.mainEnv.app_path;
	g.config = await electron_helper.tools.readJSON(g.npath.join(fp, 'config.json'));
	electron_helper.window.show();

	// Single-instance handoff: the main process forwards OS-opened files
	window.nmdv_node.ipcRenderer.on('os-open-file', async (e, filePath) => {
		const dir = g.npath.dirname(filePath);
		await rootTree({ name: g.npath.basename(dir), fs: nativeFsAdapter(), rootPath: dir }, filePath);
	});
}

// Sets disabled on BOTH the nui-button wrapper and its inner native button
// (the attribute on the wrapper alone does not gate clicks).
function setBtn(id, disabled) {
	el[id].toggleAttribute('disabled', disabled);
	el[id].querySelector('button').disabled = disabled;
}

// Native fs adapter (Electron): same handle shape the document pipeline
// already consumes — openTreePath/loadDocument/writeFile work unchanged.
function nativeFsAdapter() {
	const fsp = g.nfs, npath = g.npath;
	return {
		async readdir(dir) {
			const dirents = await fsp.readdir(dir, { withFileTypes: true });
			return dirents.map(d => ({ name: d.name, path: npath.join(dir, d.name), kind: d.isDirectory() ? 'dir' : 'file' }));
		},
		async readFileHandle(fp) {
			return {
				name: npath.basename(fp),
				_nmdvPath: fp,
				getFile: async () => new File([await fsp.readFile(fp, 'utf8')], npath.basename(fp), { type: 'text/markdown' }),
				createWritable: async () => ({
					write: async (data) => { await fsp.writeFile(fp, data, 'utf8'); },
					close: async () => {}
				})
			};
		}
	};
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
	if (!await confirmDiscard()) return;
	if (window.electron_helper) {
		// Native dialog + native adapter — any path on disk works
		const result = await electron_helper.dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open Folder' });
		if (result.canceled || !result.filePaths?.length) return;
		const dir = result.filePaths[0];
		await rootTree({ name: g.npath.basename(dir), fs: nativeFsAdapter(), rootPath: dir });
		await openFirstMarkdown();
		return;
	}
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
	await rootTree({ name: handle.name, fs: fsAccessAdapter(handle), rootPath: '' });
	await openFirstMarkdown();
}

// ################################# STARTUP FOLDER (Electron only)
// Browser FSA permissions don't survive restarts, so a persisted default
// dir is only meaningful in the Electron shell.

function updateStartupUi() {
	const dir = prefs.get('startupDir');
	el['startup-path'].textContent = dir || 'Not set';
	el['btn-startup-clear'].hidden = !dir;
}

async function chooseStartupDir() {
	const result = await electron_helper.dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Set Startup Folder' });
	if (result.canceled || !result.filePaths?.length) return;
	prefs.set('startupDir', result.filePaths[0]);
	updateStartupUi();
}

function clearStartupDir() {
	prefs.remove('startupDir');
	updateStartupUi();
}

// Tracks the in-flight background directory scan so selection can be revealed
// once the tree lands (see revealAfterScan). Settles only, never rejects.
let treeScan = Promise.resolve();

// Kick the directory scan off WITHOUT awaiting. Called only AFTER a document
// has been rendered, so the (potentially heavy) tree build never delays it.
function scanTreeInBackground() {
	const tree = el['file-tree'];
	treeScan = tree.setRoot({ name: g.treeName || 'Folder', path: g.rootPath })
		.catch((err) => console.error('nmdv: directory scan failed', err));
}

// Best-effort select of `path` in the tree, deferred until the scan finished
// (the opened document may already be rendered; the node just isn't there yet).
function revealAfterScan(path) {
	if (!path) return;
	treeScan.then(() => selectInTree(path.split(/[/\\]/).pop()));
}

async function rootTree(root, openPath = null) {
	g.fs = root.fs;
	g.rootPath = root.rootPath;
	g.treeName = root.name;
	const tree = el['file-tree'];
	tree.setProvider(g.fs.readdir);
	setBtn('btn-refresh', false);
	setBtn('btn-collapse', false);
	status(`Folder: ${root.name}`);
	if (openPath) {
		// Open the requested document FIRST — the directory scan runs after,
		// in the background, so it never delays the render.
		await openDocumentAt(openPath);
		scanTreeInBackground();
		revealAfterScan(openPath);
	}
	// No specific file: the caller (openFirstMarkdown) opens one first, then
	// starts the scan — guaranteeing the document renders before the tree.
}

// Open the alphabetically first Markdown file in the tree root. The document
// renders first; only then does the (potentially heavy) tree scan run in the
// background, revealing the opened file once its node exists.
async function openFirstMarkdown() {
	const entries = await g.fs.readdir(g.rootPath);
	const first = entries
		.filter(e => e.kind === 'file' && /\.(md|markdown)$/i.test(e.name))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))[0];
	if (!first) {
		status('No Markdown files in this folder.');
		scanTreeInBackground();
		return;
	}
	const opened = await openDocumentAt(first.path);
	scanTreeInBackground();                 // heavy scan begins after the render
	if (opened) revealAfterScan(first.path);
}

async function onTreeFile(entry) {
	if (entry.kind === 'dir') return;
	if (!/\.(md|markdown)$/i.test(entry.name)) {
		status(`${entry.name} is not a Markdown file.`);
		return;
	}
	await openTreePath(entry.path);
}

async function openTreePath(path) {
	if (path === g.fileHandle?._nmdvPath) return;
	if (!await openDocumentAt(path)) {
		// User kept the current document — restore its tree selection.
		if (g.fileHandle?._nmdvPath) el['file-tree'].select(g.fileHandle._nmdvPath);
		return;
	}
	el['file-tree'].select(path);
}

// Read + render a document at `path`. Deliberately does NOT touch the file
// tree, so callers can open a specific file before (or while) the directory
// scan is still running. Returns true when a document was opened.
async function openDocumentAt(path) {
	if (!await confirmDiscard()) return false;
	const handle = await g.fs.readFileHandle(path);
	handle._nmdvPath = path;
	const file = await handle.getFile();
	loadDocument(handle, file.name, await file.text());
	return true;
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
	selectInTree(file.name);
}

// A picked/dropped file gives us no parent folder in the browser (File
// System Access limitation — Electron resolves this via path.dirname).
// Best we can do: if a file with that exact name is loaded in the current
// tree, select it there.
function selectInTree(name) {
	const tree = el['file-tree'];
	const matches = [...tree._nodes.values()].filter(n => n.entry.kind === 'file' && n.entry.name === name);
	if (matches.length === 1) tree.select(matches[0].entry.path);
}

async function onDrop(e) {
	e.preventDefault();
	const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
	if (!item) return;
	const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;

	// Dropped a folder → same as Open Folder: root the tree, read its first file
	if (handle?.kind === 'directory') {
		if (!await confirmDiscard()) return;
		await rootTree({ name: handle.name, fs: fsAccessAdapter(handle), rootPath: '' });
		await openFirstMarkdown();
		return;
	}

	const file = item.getAsFile();
	if (!file || !/\.(md|markdown)$/i.test(file.name)) {
		status('Drop ignored: not a Markdown file.');
		return;
	}
	if (!await confirmDiscard()) return;
	if (window.electron_helper && file.path) {
		const dir = g.npath.dirname(file.path);
		await rootTree({ name: g.npath.basename(dir), fs: nativeFsAdapter(), rootPath: dir }, file.path);
		return;
	}
	loadDocument(handle, file.name, await file.text());
	selectInTree(file.name);
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
	// Explorer auto-hide: close an overlay sidebar once a file is open
	const app = document.querySelector('nui-app');
	if (app.classList.contains('sidebar-open')) app.toggleSidebar('left');
	setTitle(name);
	setBtn('btn-edit', false);
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

function resolveImageUri(url) {
	if (!url) return url;
	// Ignore absolute external URLs, data URIs, and already-resolved schemes
	if (/^(https?|data|raum|file):/i.test(url)) return url;

	if (window.electron_helper) {
		const docPath = g.fileHandle?._nmdvPath;
		const docDir = docPath ? g.npath.dirname(docPath) : g.rootPath;
		if (!docDir) return url;

		const [cleanUrl, ...rest] = url.split(/([?#].*)/);
		const extra = rest.join('');

		let target;
		if (/^[a-zA-Z]:[\\/]/.test(cleanUrl)) {
			target = g.npath.normalize(cleanUrl);
		} else {
			const rel = cleanUrl.replace(/^(\.?[\\/])+/, '');
			target = g.npath.join(docDir, rel);

			// Fallback: if not found in docDir, check workspace rootPath if different
			if (g.fsSync && g.rootPath && docDir !== g.rootPath && !g.fsSync.existsSync(target)) {
				const fromRoot = g.npath.join(g.rootPath, rel);
				if (g.fsSync.existsSync(fromRoot)) target = fromRoot;
			}
		}

		if (window.electron_helper.tools?.getFileURL) {
			return window.electron_helper.tools.getFileURL(target) + extra;
		}
		return `raum:///${target.replace(/\\/g, '/')}${extra}`;
	}
	return url;
}

function setMode(mode) {
	g.mode = mode;
	document.getElementById('md-main').hidden = mode === 'edit';
	el.editor.hidden = mode !== 'edit';
	// Save only exists in edit mode — there's nothing to save otherwise
	el['btn-save'].hidden = mode !== 'edit';
	el['btn-edit'].classList.toggle('editing', mode === 'edit');
	el['btn-edit'].querySelector('nui-icon').setAttribute('name', mode === 'edit' ? 'close' : 'edit');
	el['btn-edit'].querySelector('button').setAttribute('aria-label', mode === 'edit' ? 'Close editor (apply edits)' : 'Edit');
}

function renderView() {
	// nui-markdown renders once on connect (_processed guard) — swap in a
	// fresh element instead of mutating the connected one.
	document.getElementById('viewer')?.remove();
	const welcome = document.getElementById('welcome');
	if (welcome) welcome.remove();
	const viewer = document.createElement('nui-markdown');
	viewer.id = 'viewer';
	// No frontmatter attribute — nui-markdown defaults to 'collapsed'
	// (metadata card behind a closed <details>) since the md-blocks update.
	const s = document.createElement('script');
	s.type = 'text/markdown';
	s.textContent = g.markdown;
	viewer.appendChild(s);
	el.page.appendChild(viewer);

	if (window.electron_helper) {
		for (const img of viewer.querySelectorAll('img')) {
			const src = img.getAttribute('src');
			if (src && !/^(https?|data|raum|file):/i.test(src)) {
				img.setAttribute('src', resolveImageUri(src));
			}
		}
	}
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
