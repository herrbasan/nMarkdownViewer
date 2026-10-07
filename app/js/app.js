'use strict';

// nMarkdownViewer — stage (renderer) logic.
// Browser-first: runs against scripts/serve.js. The Electron shell (SPEC M5)
// provides window.electron_helper and OS integration; all app logic lives here.

import '../modules/nui_wc2/NUI/nui.js';
import { appWindow } from '../modules/nui_wc2/NUI/lib/modules/nui-app-window.js';
import '../modules/nui_wc2/NUI/lib/modules/nui-file-tree.js';
import '../modules/nui_wc2/NUI/lib/modules/nui-blocks-editor.js';
import { createTts } from './tts.js';
import { prefs } from './prefs.js';
import { TtsPlayerHost } from './lib/tts-player.js';
import { kindOf, langOf, isDisplayable, isTextual, NUI_LANGS } from './file-types.js';
import { highlightCode } from './highlight.js';
import { docxToFragment } from './docx.js';
import { PdfView } from './pdf-view.js';

const g = {
	config: null,
	win: null,            // appWindow chrome
	statusBar: null,
	dirHandle: null,      // FileSystemDirectoryHandle backing the tree
	fs: null,             // { readdir, readFileHandle, assetUrl } adapter
	fileHandle: null,     // FileSystemFileHandle of the open document
	fileName: '',
	docKind: 'markdown',  // what the viewer is showing — see file-types.js
	assetUrl: null,       // URL for a non-textual document
	docFragment: null,    // converted .docx nodes
	pdfView: null,        // live pdf.js view, so it can be torn down
	markdown: '',
	blocksEditor: null,   // live <nui-blocks-editor>, present only in edit mode
	dirty: false,
	mode: 'view',         // 'view' | 'edit'
	tts: null             // config-pane controller (js/tts.js), set in boot
};

const el = {};
for (const id of ['doc-title', 'btn-listen', 'btn-edit', 'btn-save', 'btn-open-folder', 'btn-open-file', 'btn-collapse', 'btn-refresh', 'tree-search', 'file-tree', 'page', 'editor', 'cfg-engine', 'cfg-model', 'cfg-model-wrap', 'cfg-voice', 'cfg-speed', 'cfg-clean', 'cfg-stitch', 'cfg-status', 'cfg-startup', 'btn-startup-choose', 'btn-startup-clear', 'startup-path', 'cfg-update', 'btn-update-check', 'update-version']) {
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
		// Closes THIS window, not the app. app.exit() would take every other
		// open document with it; the quit is left to Electron, which ends the
		// process once the last window is gone.
		onClose: () => { window.electron_helper ? electron_helper.window.close() : location.reload(); }
	});
	g.statusBar = g.win.element.querySelector('.nui-status-bar');
	// Two slots: the message (left) and the hovered link's destination (right),
	// as a browser's status bar does. A flex row, so the URL takes the slack.
	g.statusBar.innerHTML = '<span id="status-text"></span><span id="hover-url" hidden></span>';

	// Full-window drop overlay. Must be created AFTER appWindow(): with the
	// default target it wipes document.body, destroying any static markup.
	// Core component — a dynamically inserted <nui-dropzone> self-upgrades.
	// The zone min-height is inline because the component only respects a
	// pre-set inline min-height when laying out its grid.
	document.body.insertAdjacentHTML('beforeend',
		'<nui-dropzone id="dropzone"><div data-drop="open" style="min-height: calc(100vh - 2 * var(--nui-space))">Drop a Markdown file or folder to open</div></nui-dropzone>');
	el['dropzone'] = document.getElementById('dropzone');

	// App-level sidebar toggling (data-action="toggle-sidebar[:right]") —
	// a convention the app wires itself, not a NUI builtin (see nui-boilerplate).
	nui.registerAction('toggle-sidebar', (target, el, e, param) => {
		document.querySelector('nui-app')?.toggleSidebar?.(param || 'left');
		return true;
	});

	el['btn-open-folder'].addEventListener('click', () => openFolder().catch(reportOpenError('folder')));
	el['btn-open-file'].addEventListener('click', () => openFile().catch(reportOpenError('file')));
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

	// Link routing. Bound on el.page: one delegated pair survives every
	// document re-render into the viewer. Wired in BOTH shells — an
	// unrouted anchor navigates the window to the href, which in the browser
	// means the app is simply gone.
	el.page.addEventListener('click', onLinkClick);
	el.page.addEventListener('pointerover', onLinkHover);
	el.page.addEventListener('pointerout', clearHoverUrl);
	el.page.addEventListener('focusin', onLinkHover);
	el.page.addEventListener('focusout', clearHoverUrl);

	// Full-window drag & drop: the nui-dropzone overlay owns the window-level
	// drag listeners (incl. the dragover preventDefault Electron needs); we
	// consume its drop event — detail.originalEvent is the native drop event.
	el['dropzone'].addEventListener('nui-dropzone-drop', (e) => onDrop(e.detail.originalEvent));

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
	// A linked document arrives as ?file= (main.js); it wins over the single-instance
	// global, which still names the FIRST window's document.
	const linked = new URLSearchParams(location.search).get('file');
	if (linked || g.mainEnv?.filePath) {
		const fp = linked || g.mainEnv.filePath;
		const dir = g.npath.dirname(fp);
		await rootTree(
			// basename('X:\\') is '' — a drive root would show an unnamed tree.
			{ name: g.npath.basename(dir) || dir, fs: nativeFsAdapter(), rootPath: dir },
			fp
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
	el['cfg-update'].hidden = false;  // update check is Electron-only (Squirrel)
	g.mainEnv = await electron_helper.global.get('env');
	el['update-version'].textContent = `v${g.mainEnv.version}`;
	el['btn-update-check'].addEventListener('click', () => {
		window.nmdv_node.ipcRenderer.send('check-for-updates');
	});
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
		},
		// A URL the <img>/<video>/<audio> can load. The file is never read
		// into the renderer — the helper's `raum` protocol serves it from
		// disk, which is also why this works for bytes that are not text.
		async assetUrl(fp) {
			return `raum:///${fp.replace(/\\/g, '/')}`;
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
		readFileHandle: (path) => walk(path, true),
		// The browser has no path — the only way to a byte-exact URL is the
		// handle's File. Object URLs are single-use per document, so each one
		// is revoked when the document changes.
		async assetUrl(path, handle) {
			const url = URL.createObjectURL(await handle.getFile());
			assetUrls.push(url);
			return url;
		}
	};
}

// Object URLs minted for the current binary document. Released on every
// document change — a viewer left open over many videos would otherwise pin
// every one of them in memory.
let assetUrls = [];

function releaseAssetUrls() {
	for (const u of assetUrls) URL.revokeObjectURL(u);
	assetUrls = [];
}


// A failed open must never die as an unhandled rejection: the picker is the
// app's front door, and a silent door reads as a broken app.
function reportOpenError(what) {
	return (err) => {
		status(`Open ${what} failed: ${err.message || err}`);
		throw err;
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

// Open the alphabetically first file the viewer can display. The document
// renders first; only then does the (potentially heavy) tree scan run in the
// background, revealing the opened file once its node exists.
async function openFirstMarkdown() {
	const entries = await g.fs.readdir(g.rootPath);
	const first = entries
		.filter(e => e.kind === 'file' && isDisplayable(e.name))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))[0];
	if (!first) {
		status('No displayable files in this folder.');
		scanTreeInBackground();
		return;
	}
	const opened = await openDocumentAt(first.path);
	scanTreeInBackground();                 // heavy scan begins after the render
	if (opened) revealAfterScan(first.path);
}

async function onTreeFile(entry) {
	if (entry.kind === 'dir') return;
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
	const name = path.split(/[\\/]/).pop();
	const kind = kindOf(name);
	const handle = await g.fs.readFileHandle(path);
	handle._nmdvPath = path;

	// A file we cannot render is still worth opening: naming it, and offering
	// the OS, beats a status line the user has already looked past.
	if (!kind) {
		loadUnsupported(handle, name, path);
		return true;
	}

	// A .docx is unpacked and converted. A PDF is rendered by pdf.js. Neither is
	// text, so neither is read with getFile().text(). A PDF is read as BYTES:
	// fetch() over raum:// is CORS-blocked from a file:// origin, so handing
	// pdf.js a URL would fail for a reason that looks like a corrupt file.
	if (kind === 'pdf') {
		loadPdf(handle, name, path);
		return true;
	}
	if (kind === 'docx') {
		loadDocx(handle, name, path);
		return true;
	}

	// Binary kinds are never decoded as text — a JPEG read as UTF-8 is
	// corruption, and it is also the slow path for a large video. Only the
	// textual kinds pay for a read.
	if (isTextual(name)) {
		const file = await handle.getFile();
		loadDocument(handle, name, await file.text(), kind);
	} else {
		loadAsset(handle, name, kind, await g.fs.assetUrl(path, handle));
	}
	return true;
}

async function openFile() {
	if (!window.showOpenFilePicker) {
		throw new Error('File System Access API unavailable — use Chrome/Edge or the Electron shell');
	}
	if (!await confirmDiscard()) return;
	let handle;
	try {
		[handle] = await window.showOpenFilePicker({ multiple: false });
	} catch (err) {
		if (err.name === 'AbortError') return;
		throw err;
	}
	const file = await handle.getFile();
	const kind = kindOf(file.name);
	if (!kind) {
		// No tree path here (a picked file has no parent in the browser), so
		// the OS button is absent — but the user still learns what it is.
		handle._nmdvPath = '';
		loadUnsupported(handle, file.name, '');
		return;
	}
	if (isTextual(file.name)) loadDocument(handle, file.name, await file.text(), kind);
	else loadAsset(handle, file.name, kind, await g.fs.assetUrl('', handle));
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
	const dt = e.dataTransfer;
	if (!dt) return;

	// Electron: resolve the native path (File.path was removed from modern
	// Electron — webUtils.getPathForFile is the replacement). Dropped files
	// AND folders both arrive as File entries; stat decides which we got.
	if (window.electron_helper) {
		const dropped = [...dt.files][0];
		if (!dropped) return;
		const p = window.nmdv_node.webUtils.getPathForFile(dropped);
		if (!p) {
			status('Drop ignored: item has no local path.');
			return;
		}
		const st = await g.nfs.stat(p);
		if (st.isDirectory()) {
			if (!await confirmDiscard()) return;
			await rootTree({ name: g.npath.basename(p), fs: nativeFsAdapter(), rootPath: p });
			await openFirstMarkdown();
			return;
		}
		if (!/\.(md|markdown)$/i.test(p) && !isDisplayable(p)) {
			status('Drop ignored: not a file the viewer can display.');
			return;
		}
		const dir = g.npath.dirname(p);
		await rootTree({ name: g.npath.basename(dir), fs: nativeFsAdapter(), rootPath: dir }, p);
		return;
	}

	// Browser: File System Access handles from the dropped items.
	const item = [...(dt.items || [])].find(i => i.kind === 'file');
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
	if (!file || !isDisplayable(file.name)) {
		status('Drop ignored: not a file the viewer can display.');
		return;
	}
	if (!await confirmDiscard()) return;
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

function loadDocument(handle, name, text, kind = 'markdown') {
	g.tts?.stop();
	releaseAssetUrls();
	// Any live pdf.js view goes BEFORE the host is replaced: its observers
	// would otherwise keep rendering into a detached element, and a second
	// view racing it throws "same canvas during multiple render operations".
	g.pdfView?.destroy();
	g.pdfView = null;
	g.fileHandle = handle;
	g.fileName = name;
	g.docKind = kind;
	g.assetUrl = null;
	g.docFragment = null;
	g.markdown = text;
	g.blocksEditor = null;
	g.dirty = false;
	setMode('view');
	renderView();
	document.getElementById('md-main').scrollTop = 0; // new document starts at the top
	// Explorer auto-hide: close an overlay sidebar once a file is open
	const app = document.querySelector('nui-app');
	if (app.classList.contains('sidebar-open')) app.toggleSidebar('left');
	setTitle(name);
	afterLoad(name, text.length);
}

// A non-textual document: the bytes stay on disk, the viewer gets a URL.
// `g.markdown` stays empty so Listen has nothing to speak and the editor
// never opens — the only thing the app can do with an image is look at it.
function loadAsset(handle, name, kind, url) {
	g.tts?.stop();
	releaseAssetUrls();
	g.pdfView?.destroy();
	g.pdfView = null;
	g.fileHandle = handle;
	g.fileName = name;
	g.docKind = kind;
	g.assetUrl = url;
	g.docFragment = null;
	g.markdown = '';
	g.blocksEditor = null;
	g.dirty = false;
	setMode('view');
	renderView();
	document.getElementById('md-main').scrollTop = 0;
	const app = document.querySelector('nui-app');
	if (app.classList.contains('sidebar-open')) app.toggleSidebar('left');
	setTitle(name);
	afterLoad(name, null);
}

// A file with no renderer of its own — a .zip, an .exe, a .docx. It is shown
// rather than refused, because the user picked it deliberately (dropped it,
// double-clicked it, clicked it in the tree) and a status line is not an
// answer. The one action that still works is handing it to the OS, so the
// view offers exactly that.
function loadUnsupported(handle, name, path) {
	g.tts?.stop();
	releaseAssetUrls();
	g.pdfView?.destroy();
	g.pdfView = null;
	g.fileHandle = handle;
	g.fileName = name;
	g.docKind = 'unsupported';
	g.assetUrl = null;
	g.docFragment = null;
	g.markdown = '';
	g.blocksEditor = null;
	g.dirty = false;
	setMode('view');
	renderView();
	document.getElementById('md-main').scrollTop = 0;
	const app = document.querySelector('nui-app');
	if (app.classList.contains('sidebar-open')) app.toggleSidebar('left');
	setTitle(name);
	afterLoad(name, null);
}

// A .docx is read as BYTES and converted, never as text. The conversion
// happens off the critical path: the pane shows the name immediately and the
// document swaps in when the ZIP has been walked, so a large file does not
// leave the window blank.
async function loadDocx(handle, name, path) {
	loadAsset(handle, name, 'docx', null);
	try {
		const bytes = await g.nfs.readFile(path);
		g.docFragment = docxToFragment(bytes, window.nmdv_node.zlib);
		if (g.fileName !== name) return;              // the user moved on
		renderView();
	} catch (err) {
		status(`Cannot read ${name}: ${err.message}`);
	}
}

// A .pdf is drawn by pdf.js, off the critical path: the pane shows the name
// and the document swaps in once the bytes are read and parsed.
async function loadPdf(handle, name, path) {
	loadAsset(handle, name, 'pdf', null);
	try {
		const buf = await g.nfs.readFile(path);
		if (g.fileName !== name) return;              // the user moved on
		// Replace the placeholder the load created, then hand the host THAT
		// element. PdfView rewrites its host's contents, so pointing it at
		// el.page would wipe the page and leave nothing for the next
		// renderView() to find.
		document.getElementById('viewer')?.remove();
		const host = document.createElement('div');
		host.id = 'viewer';
		host.className = 'asset asset-pdf';
		// breakout spans the full content width; without it the reading
		// measure letterboxes the viewer into a 992px column. renderAsset
		// normally sets this, and pdf bypasses that path entirely.
		host.setAttribute('breakout', '');
		el.page.appendChild(host);
		g.pdfView = new PdfView(host, new Uint8Array(buf), name);
		await g.pdfView.mount();
	} catch (err) {
		status(`Cannot read ${name}: ${err.message}`);
	}
}

// Toolbar state is a function of the KIND, not of which file was picked.
function afterLoad(name, charCount) {
	setBtn('btn-edit', g.docKind !== 'markdown');
	setBtn('btn-listen', !g.tts?.available || !g.markdown);
	status(`Opened ${name}${charCount === null ? '' : ` (${charCount} chars)`}`);
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

// ################################# LINKS
//
// Three destinations, decided by the href alone:
//   web (http/https/mailto) → the OS browser, never an Electron window
//   local, displayable here  → a new nMarkdownViewer window
//   local, anything else     → the OS handler for that file type
// A bare #fragment stays in-document. nui-markdown emits anchors with no
// target, so nothing is intercepted before this — the stage is the only
// routing point, and main.js guards the navigation it can't catch.
//
// "Displayable" is the same table the viewer itself uses (file-types.js), so
// a linked image opens the way a dropped image does.

function currentDocDir() {
	const docPath = g.fileHandle?._nmdvPath;
	if (docPath) return g.npath.dirname(docPath);
	return g.rootPath || null;
}

// Resolve a document-relative href to an absolute path. Reuses the image
// resolver's rules (absolute passthrough, rootPath fallback) so a link and
// an image pointing at the same place cannot disagree.
function resolveDocHref(href) {
	const [clean, ...rest] = href.split(/([?#].*)/);
	const extra = rest.join('');
	if (!clean) return null;
	if (!window.electron_helper || !g.npath) return null;

	const docDir = currentDocDir();
	if (!docDir) return null;

	let target;
	if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith('\\\\')) {
		target = g.npath.normalize(clean);
	} else {
		target = g.npath.resolve(docDir, clean);
		if (g.fsSync && g.rootPath && docDir !== g.rootPath && !g.fsSync.existsSync(target)) {
			const fromRoot = g.npath.resolve(g.rootPath, clean);
			if (g.fsSync.existsSync(fromRoot)) target = fromRoot;
		}
	}
	return { path: target, extra };
}

// True for hrefs the OS browser owns. mailto included: it is a web scheme to
// the shell, and passing it to openExternal is the documented route.
function isWebHref(href) {
	return /^(https?|mailto):/i.test(href);
}

async function onLinkClick(e) {
	// Middle/ctrl/shift-click are the browser's "open elsewhere" gestures;
	// honouring them here would need a menu, so leave them to the guard in
	// main.js, which opens web URLs externally and refuses the rest.
	if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
	const a = e.target.closest?.('a[href]');
	if (!a || !el.page.contains(a)) return;

	const href = a.getAttribute('href');
	// Same-document fragment: the browser's own job, and the only case where
	// a hash may legitimately appear on a non-web href.
	if (!href || href.startsWith('#')) return;

	e.preventDefault();

	// The OS is a boundary: it can lack a handler for a file type, or refuse
	// a URL. A rejected invoke is reported, never swallowed.
	try {
		if (isWebHref(href)) {
			// The browser shell has no OS browser to hand off to; a new tab is
			// the same destination from where the user is standing.
			if (window.electron_helper) await window.nmdv_node.ipcRenderer.invoke('open-external', href);
			else window.open(href, '_blank', 'noopener');
			return;
		}

		const resolved = resolveDocHref(href);
		if (!resolved) {
			// No path in this window (browser File System Access handles have
			// none). Said plainly rather than silently swallowing the click.
			status(`Cannot open ${href} — no file path here. Use the desktop app for local links.`);
			return;
		}
		const target = resolved.path + resolved.extra;

		// Anything the viewer can put on screen earns its own window — a
		// linked image or audio file is a document now, not an attachment.
		if (isDisplayable(resolved.path)) {
			await window.nmdv_node.ipcRenderer.invoke('open-doc-window', resolved.path);
			return;
		}
		await window.nmdv_node.ipcRenderer.invoke('open-local', target);	} catch (err) {
		status(`Cannot open ${href}: ${err.message}`);
	}
}

// Browser-like: the status bar shows the destination while the pointer is on
// a link, and the previous message returns when it leaves. Bound on the
// viewer container, so it covers the markdown re-render on every document.
function onLinkHover(e) {
	const a = e.target.closest?.('a[href]');
	if (!a || !el.page.contains(a)) { clearHoverUrl(); return; }
	const href = a.getAttribute('href');
	const resolved = (!isWebHref(href) && !href.startsWith('#')) ? resolveDocHref(href) : null;
	showHoverUrl(resolved ? resolved.path + resolved.extra : href);
}

function showHoverUrl(url) {
	const bar = g.statusBar?.querySelector('#hover-url');
	if (!bar) return;
	bar.textContent = url;
	bar.hidden = false;
	g.statusBar.classList.add('showing-url');
}

function clearHoverUrl() {
	const bar = g.statusBar?.querySelector('#hover-url');
	if (!bar || bar.hidden) return;
	bar.hidden = true;
	bar.textContent = '';
	g.statusBar.classList.remove('showing-url');
}

function setMode(mode) {
	g.mode = mode;
	const editing = mode === 'edit';
	// The blocks editor must sit directly under nui-page (breakout contract),
	// so it lives INSIDE the page and the main area stays visible; the rendered
	// viewer is what gets tucked away.
	const viewer = document.getElementById('viewer');
	if (viewer && viewer !== g.blocksEditor) viewer.hidden = editing;
	if (g.blocksEditor) g.blocksEditor.hidden = !editing;
	// Save only exists in edit mode — there's nothing to save otherwise
	el['btn-save'].hidden = !editing;
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

	if (g.docKind === 'markdown') return renderMarkdown();
	renderAsset();
}

function renderMarkdown() {
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

// Chrome per kind. The wrapper carries the kind as a class so all of this
// lives in main.css — a `.md` link and a dragged `.mp3` are the same code
// path, and the layout is one stylesheet away from review.
function renderAsset() {
	const wrap = document.createElement('div');
	wrap.id = 'viewer';
	wrap.className = `asset asset-${g.docKind}`;
	const src = g.assetUrl;

	// A picture or a video is not prose: the reading measure would letterbox
	// it into a strip. `breakout` is the theme's own way to let a child of
	// nui-page span the full container while keeping the text-flow gutter.
	if (g.docKind === 'image' || g.docKind === 'video' || g.docKind === 'text' || g.docKind === 'pdf') {
		wrap.setAttribute('breakout', '');
	}

	if (g.docKind === 'image') {
		const img = document.createElement('img');
		img.src = src;
		img.alt = g.fileName;
		wrap.appendChild(img);

	} else if (g.docKind === 'video' || g.docKind === 'audio') {
		// A card, because a bare <video> at the full column width is a black
		// rectangle with a progress bar in it. Audio is capped much narrower
		// than video — it has no picture, so the width would be dead space.
		// The sizing class is on OUR wrapper: a NUI component never carries
		// one, and never gets styled.
		wrap.innerHTML = `
			<div class="asset-card">
				<nui-card>
					<nui-media-player type="${g.docKind}" pause-others>
						<${g.docKind} src="${escapeAttr(src)}" controls preload="metadata"></${g.docKind}>
					</nui-media-player>
					<p class="asset-name"></p>
				</nui-card>
			</div>`;
		wrap.querySelector('.asset-name').textContent = g.fileName;

	} else if (g.docKind === 'text') {
		const ed = document.createElement('nui-code-editor');
		ed.setAttribute('data-lang', langOf(g.fileName) || 'txt');
		ed.setAttribute('aria-label', g.fileName);
		wrap.appendChild(ed);
	} else if (g.docKind === 'html') {
		// Sandboxed, and deliberately WITHOUT allow-same-origin. This window
		// runs nodeIntegration, so injecting the file into our own document
		// would hand any script on disk full Node access; a sandboxed frame
		// with an opaque origin gets normal rendering and no route back.
		const frame = document.createElement('iframe');
		frame.className = 'asset-frame';
		frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.src = src;
		wrap.appendChild(frame);

	} else if (g.docKind === 'docx') {
		// Our own nodes, built with createTextNode — never innerHTML over
		// document.xml, which is untrusted input from disk.
		wrap.classList.add('asset-docx');
		if (g.docFragment) wrap.appendChild(g.docFragment);
		else {
			wrap.innerHTML = '<p class="asset-note">Reading document…</p>';
		}

	} else if (g.docKind === 'unsupported') {
		wrap.innerHTML = `
			<div class="asset-card asset-unopenable">
				<nui-icon name="open_in_full"></nui-icon>
				<p class="asset-name"></p>
				<p class="asset-note">nMarkdownViewer has no viewer for this file type.</p>
			</div>`;
		wrap.querySelector('.asset-name').textContent = g.fileName;

		// The OS is the only route out, and it needs both the desktop shell
		// and a real path — a browser handle carries neither, and a file
		// picked through the open dialog has no parent to resolve one from.
		const osPath = g.fileHandle?._nmdvPath;
		if (window.electron_helper && osPath) {
			wrap.querySelector('.asset-unopenable')
				.insertAdjacentHTML('beforeend',
					'<nui-button><button type="button">Open in default app</button></nui-button>');
			wrap.querySelector('button').addEventListener('click', async () => {
				try {
					await window.nmdv_node.ipcRenderer.invoke('open-local', osPath);
				} catch (err) {
					status(`Cannot open ${g.fileName}: ${err.message}`);
				}
			});
		}
	}

	el.page.appendChild(wrap);

	// nui-code-editor builds its DOM in connectedCallback, and its value
	// setter writes straight into that DOM — so the value can only be
	// assigned once the element is CONNECTED, or it throws on an undefined
	// _editor. The isConnected guard drops the work if the document changed
	// while we waited for the definition.
	if (g.docKind === 'text') {
		const ed = wrap.querySelector('nui-code-editor');
		const lang = langOf(g.fileName);
		// The component's own highlighter owns the five dialects it ships.
		// For anything else it emits escaped plain text, so the app-side
		// highlighter fills the gap — with the same hl-* classes, so one
		// stylesheet covers both.
		const appHighlighted = NUI_LANGS.has(lang) ? null : highlightCode(g.markdown, lang);
		customElements.whenDefined('nui-code-editor').then(() => {
			if (!ed.isConnected) return;
			ed.value = g.markdown;
			const input = ed.querySelector('.nui-code-editor-input');
			// nui-code-editor is contenteditable by design and has no
			// read-only switch; a file opened for VIEWING must not invite
			// edits that go nowhere.
			input?.setAttribute('contenteditable', 'false');
			if (appHighlighted !== null && input) {
				input.innerHTML = appHighlighted + (g.markdown.endsWith('\n') ? '<br>' : '');
			}
		});
	}
}

function escapeAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function toggleEdit() {
	if (g.mode === 'view') enterEdit();
	else applyEdit();
}

function enterEdit() {
	const viewer = document.getElementById('viewer');
	if (viewer) viewer.hidden = true;
	// Fresh editor per session: the component renders once from its own state,
	// and a leftover instance would alias the previous document.
	const ed = document.createElement('nui-blocks-editor');
	ed.id = 'blocks-editor';
	ed.setAttribute('preview', 'hidden');
	ed.openMediaLibrary = pickMedia;
	ed.load(g.markdown);
	g.blocksEditor = ed;
	el.page.appendChild(ed);
	setMode('edit');
}

function applyEdit() {
	const ed = g.blocksEditor;
	if (!ed) { setMode('view'); return; }
	g.markdown = ed.serialize();
	ed.destroy();
	ed.remove();
	g.blocksEditor = null;
	if (!g.dirty) {
		g.dirty = true;
		setTitle(g.fileName);
	}
	setMode('view');
	renderView();
	status('Edits applied (unsaved)');
}

// ################################# MEDIA PICKER (host side of nui-blocks-editor)

const MEDIA_FILTERS = {
	image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'] }],
	player: [{ name: 'Audio/Video', extensions: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'] }]
};

// Contract of the editor's openMediaLibrary hook: async ({ multiple, filterType })
// → [{ src, label }] or [] on cancel. The src we return is written verbatim into
// the document, so it must be a path that SURVIVES a save: relative to the open
// document when possible, absolute otherwise.
async function pickMedia({ multiple = true, filterType = null } = {}) {
	if (window.electron_helper) {
		const filters = filterType ? MEDIA_FILTERS[filterType] : [...MEDIA_FILTERS.image, ...MEDIA_FILTERS.player];
		const result = await electron_helper.dialog.showOpenDialog({
			title: multiple ? 'Insert Media' : 'Choose Media',
			properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
			filters
		});
		if (result.canceled) return [];
		return result.filePaths.map(p => ({ src: pathToDocHref(p), label: g.npath.basename(p) }));
	}
	// Browser phase: FS Access handles. Blob URLs are session-only — they die
	// with the page and the saved markdown would reference nothing. Say so.
	let handles;
	try {
		handles = await showOpenFilePicker({ multiple });
	} catch (e) {
		if (e.name === 'AbortError') return [];
		throw e;
	}
	status('Browser pick: media references are session-only and will not survive a save (path-backed picks need the Electron shell).');
	return handles.map(f => ({ src: URL.createObjectURL(f), label: f.name }));
}

// Path relative to the open document's folder (portable in the saved file);
// falls back to the absolute path when the pick lies outside it.
function pathToDocHref(p) {
	const docPath = g.fileHandle?._nmdvPath;
	const docDir = docPath ? g.npath.dirname(docPath) : g.rootPath;
	if (docDir) {
		const rel = g.npath.relative(docDir, p);
		if (rel && !rel.startsWith('..') && !g.npath.isAbsolute(rel)) {
			return rel.split(g.npath.sep).join('/');
		}
	}
	return p.replace(/\\/g, '/');
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
