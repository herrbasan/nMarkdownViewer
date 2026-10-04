'use strict';

// nMarkdownViewer — Electron main process. Thin shell only:
// window, config, argv file handoff, file association. All app logic
// lives in the renderer stage (app/js/app.js).

if (require('electron-squirrel-startup')) return;

const { app, Menu, screen, ipcMain, shell, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const helper = require('../modules/electron_helper/helper_new.js');
const update = require('../modules/electron_helper/update.js');

const UPDATE_REPO = 'herrbasan/nMarkdownViewer';

const env = {
	isPackaged: app.isPackaged,
	app_path: app.getAppPath(),
	base_path: app.getAppPath(),
	userData: app.getPath('userData'), // renderer prefs.json location
	version: app.getVersion(),
	filePath: null
};

// Single instance (SoundApp behavior): a second OS open forwards the file
// to a running window instead of booting a new instance. Linked documents
// open their own windows, so "the running window" is not a fixed one.
let mainWin = null;
if (app.requestSingleInstanceLock()) {
	app.on('second-instance', (e, argv) => {
		const fp = fileArgFrom(argv);
		const target = liveWindow();
		if (target) {
			if (target.isMinimized()) target.restore();
			target.focus();
			if (fp) target.webContents.send('os-open-file', path.resolve(fp));
		}
	});
	init().catch(err => { console.error('main : FATAL', err); app.exit(1); });
} else {
	app.quit();
}

// Any window that can still take a message. mainWin is cleared when it
// closes, and linked windows outlive it — asking a destroyed BrowserWindow
// for its state throws.
function liveWindow() {
	if (mainWin && !mainWin.isDestroyed()) return mainWin;
	const all = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
	return all.find(w => w.isFocused()) || all[0] || null;
}

if (env.isPackaged) {
	if (process.env.PORTABLE_EXECUTABLE_DIR) {
		env.base_path = process.env.PORTABLE_EXECUTABLE_DIR;
	} else {
		const ar = process.execPath.split(path.sep);
		ar.length -= 2;
		env.base_path = ar.join(path.sep) + path.sep;
	}
}

// ################################# WINDOW STATE (SoundApp pattern)

const statePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
	try {
		const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
		if (typeof s.width !== 'number' || typeof s.height !== 'number') return null;
		// Saved position must still be on a connected display (monitors change)
		if (typeof s.x === 'number' && typeof s.y === 'number') {
			const onScreen = screen.getAllDisplays().some(d =>
				s.x >= d.bounds.x && s.x < d.bounds.x + d.bounds.width &&
				s.y >= d.bounds.y && s.y < d.bounds.y + d.bounds.height);
			if (!onScreen) { delete s.x; delete s.y; }
		}
		return s;
	} catch {
		return null;
	}
}

function trackWindowState(win) {
	let timer = null;
	const save = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			fsp.writeFile(statePath, JSON.stringify(win.getBounds())).catch(() => {});
		}, 500);
	};
	win.on('resize', save);
	win.on('move', save);
	win.on('close', () => {
		clearTimeout(timer);
		try { fs.writeFileSync(statePath, JSON.stringify(win.getBounds())); } catch {}
	});
}

// A renderer must never navigate its own window away from app/index.html: an
// anchor the stage did not intercept (ctrl+click, middle-click, raw HTML
// inside a document) would otherwise replace the app with a web page and
// leave a frame with no way back. Web URLs are handed to the OS browser
// instead — the same destination a plain left-click resolves to.
function installNavigationGuards(win) {
	win.webContents.on('will-navigate', (event, url) => {
		event.preventDefault();
		if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
}

ipcMain.handle('open-external', async (e, url) => {
	if (!/^(https?|mailto):/i.test(url)) throw new Error(`Refusing to hand a non-web URL to the OS: ${url}`);
	await shell.openExternal(url);
});

ipcMain.handle('open-local', async (e, filePath) => {
	// openPath reports failure by RESOLVING to an error string, not by
	// rejecting — an unhandled file type would otherwise look like success.
	const err = await shell.openPath(filePath);
	if (err) throw new Error(err);
});

ipcMain.handle('open-pdf-window', async (e, filePath) => {
	const abs = path.resolve(filePath);
	if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

	// Chromium's PDF viewer is an internal component that will not run inside
	// an <iframe> — it refuses to render in a subframe — so a PDF gets its own
	// top-level window, where the real viewer (toolbar, zoom, page nav) loads.
	// The raum:// protocol serves the bytes from disk exactly as it does for
	// images, so the viewer sees a normal PDF response.
	const b = liveWindow()?.getBounds() ?? null;
	const win = new BrowserWindow({
		width: b ? b.width : 1100,
		height: b ? b.height : 800,
		...(b ? { x: b.x + 32, y: b.y + 32 } : {}),
		title: path.basename(abs),
		backgroundColor: '#1c1c1c'
	});
	await win.loadURL('raum:///' + abs.replace(/\\/g, '/'));
	// No navigation guard here: this window exists to navigate, and a PDF
	// viewer that cannot follow a link inside the document is broken.
	return true;
});

ipcMain.handle('open-doc-window', async (e, filePath) => {
	const abs = path.resolve(filePath);
	// Extension policy belongs to the stage (file-types.js) — main only
	// guarantees the thing exists. Anything that isn't a file at all fails
	// here rather than opening an empty window.
	if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
	if (fs.statSync(abs).isDirectory()) throw new Error(`Not a file: ${abs}`);

	// The document travels in the query string. The helper's browserWindow()
	// loads through loadFile(), which cannot carry one, and env is a
	// process-global — a second window reading it would get the FIRST window's
	// document, not the one that was linked.
	const target = new URL(pathToFileURL(path.join(__dirname, '..', 'index.html')).href);
	target.searchParams.set('file', abs);

	const b = liveWindow()?.getBounds() ?? null;
	const win = await helper.tools.browserWindow('frameless', {
		webPreferences: { preload: path.join(__dirname, '../modules/electron_helper/helper_new.js') },
		devTools: !env.isPackaged,
		width: b ? b.width : 1100,
		height: b ? b.height : 800,
		...(b ? { x: b.x + 32, y: b.y + 32 } : {}),
		url: target.href
	});
	installNavigationGuards(win);
	// Deliberately NOT trackWindowState: one window-state.json belongs to the
	// main window, and a second writer would fight it on every move.
	return true;
});

// Any FILE the OS handed us, whatever its type. Whether the viewer can
// display it is the stage's question (file-types.js) — main only has to tell
// a path argument apart from the exe, a flag, or the app directory. Matching
// on a .md extension instead would drop every image and video the user
// double-clicks, and silently fall through to the startup folder.
function fileArgFrom(argv) {
	for (const a of argv.slice(1)) {
		if (typeof a !== 'string' || a.startsWith('-') || !path.isAbsolute(a)) continue;
		try {
			if (fs.statSync(a).isFile()) return path.resolve(a);
		} catch { /* not a path we can read — keep looking */ }
	}
	return null;
}

async function init() {
	// File opened via OS (double-click / drag onto icon / CLI arg)
	env.filePath = fileArgFrom(process.argv);

	let fp = env.isPackaged ? path.dirname(env.app_path) : env.app_path;
	const config = await helper.tools.readJSON(path.join(fp, 'config.json'));
	env.config_present = !!config;

	if (env.isPackaged) registerFileAssociation();

	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
	global.env = env;

	await app.whenReady();

	const state = loadWindowState();
	mainWin = await helper.tools.browserWindow('frameless', {
		webPreferences: { preload: path.join(__dirname, '../modules/electron_helper/helper_new.js') },
		devTools: !env.isPackaged,
		width: state?.width ?? 1100,
		height: state?.height ?? 800,
		...(typeof state?.x === 'number' ? { x: state.x, y: state.y } : {}),
		file: 'app/index.html'
	});
	installNavigationGuards(mainWin);
	trackWindowState(mainWin);
	// Cleared on close so the OS file-handoff never reaches a dead window.
	mainWin.on('closed', () => { mainWin = null; });

	// Renderer console → terminal (dev visibility)
	if (!env.isPackaged) {
		mainWin.webContents.on('console-message', (e, level, message) => { console.log('stage :', message); });
	}

	Menu.setApplicationMenu(null);

	// Auto-update (GitHub releases, SoundApp pattern): silent startup check —
	// the splash only appears when a newer release exists. Packaged builds
	// only: autoUpdater needs the Squirrel install to apply anything.
	if (env.isPackaged) setTimeout(checkUpdate, 1500);

	// Manual check from the config pane — always shows the update window.
	ipcMain.on('check-for-updates', () => {
		update.checkWithUI(UPDATE_REPO, updateProgress, { useSemVer: true });
	});
}

async function checkUpdate() {
	const check = await update.checkVersion(UPDATE_REPO, 'git', true);
	if (check.status && check.isNew) {
		console.log('main : update available: v' + check.remote_version);
		update.init({ mode: 'splash', url: UPDATE_REPO, source: 'git', progress: updateProgress, check, useSemVer: true });
	} else {
		console.log('main : no update available');
	}
}

function updateProgress(e) {
	if (e.type === 'log') console.log('main : updater:', e.data);
}

// File association (.md/.markdown) in HKCU — per-user, no admin needed.
// Squirrel installs per-user, so this matches the install scope.
// DefaultIcon is wired but only written when a real md.ico ships —
// without it Windows falls back to the app icon (placeholder situation).
function registerFileAssociation() {
	const { spawn } = require('node:child_process');
	const exe = process.execPath;
	const progid = 'nMarkdownViewer.md';
	const cmds = [
		['HKCU\\Software\\Classes\\.md', '/ve', '/d', progid],
		['HKCU\\Software\\Classes\\.markdown', '/ve', '/d', progid],
		[`HKCU\\Software\\Classes\\${progid}`, '/ve', '/d', 'Markdown Document'],
		[`HKCU\\Software\\Classes\\${progid}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`]
	];
	const iconFp = path.join(path.dirname(exe), 'resources', 'icons', 'md.ico');
	if (fs.existsSync(iconFp)) {
		cmds.push([`HKCU\\Software\\Classes\\${progid}\\DefaultIcon`, '/ve', '/d', iconFp]);
	}
	for (const [key, ...rest] of cmds) {
		const child = spawn('reg', ['add', key, ...rest, '/f'], { windowsHide: true });
		child.on('error', err => console.error('main : file association failed for', key, err.message));
	}
}
