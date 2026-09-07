'use strict';

// nMarkdownViewer — Electron main process. Thin shell only:
// window, config, argv file handoff, file association. All app logic
// lives in the renderer stage (app/js/app.js).

if (require('electron-squirrel-startup')) return;

const { app, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const helper = require('../modules/electron_helper/helper_new.js');

const env = {
	isPackaged: app.isPackaged,
	app_path: app.getAppPath(),
	base_path: app.getAppPath(),
	filePath: null
};

if (env.isPackaged) {
	if (process.env.PORTABLE_EXECUTABLE_DIR) {
		env.base_path = process.env.PORTABLE_EXECUTABLE_DIR;
	} else {
		const ar = process.execPath.split(path.sep);
		ar.length -= 2;
		env.base_path = ar.join(path.sep) + path.sep;
	}
}

init().catch(err => { console.error('main : FATAL', err); app.exit(1); });

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

async function init() {
	// File opened via OS (double-click / drag onto icon / CLI arg)
	const fileArg = process.argv.find(a => /\.(md|markdown)$/i.test(a) && fs.existsSync(a));
	env.filePath = fileArg ? path.resolve(fileArg) : null;

	let fp = env.isPackaged ? path.dirname(env.app_path) : env.app_path;
	const config = await helper.tools.readJSON(path.join(fp, 'config.json'));
	env.config_present = !!config;

	if (env.isPackaged) registerFileAssociation();

	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
	global.env = env;

	await app.whenReady();

	const state = loadWindowState();
	const win = await helper.tools.browserWindow('frameless', {
		webPreferences: { preload: path.join(__dirname, '../modules/electron_helper/helper_new.js') },
		devTools: !env.isPackaged,
		width: state?.width ?? 1100,
		height: state?.height ?? 800,
		...(typeof state?.x === 'number' ? { x: state.x, y: state.y } : {}),
		file: 'app/index.html'
	});
	trackWindowState(win);

	// Renderer console → terminal (dev visibility)
	if (!env.isPackaged) {
		win.webContents.on('console-message', (e, level, message) => { console.log('stage :', message); });
	}

	Menu.setApplicationMenu(null);
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
