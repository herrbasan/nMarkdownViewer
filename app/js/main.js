'use strict';

// nMarkdownViewer — Electron main process. Thin shell only:
// window, config, argv file handoff, file association. All app logic
// lives in the renderer stage (app/js/app.js).

if (require('electron-squirrel-startup')) return;

const { app, Menu } = require('electron');
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

	const win = await helper.tools.browserWindow('frameless', {
		webPreferences: { preload: path.join(__dirname, '../modules/electron_helper/helper_new.js') },
		devTools: !env.isPackaged,
		width: 1100,
		height: 800,
		file: 'app/index.html'
	});

	// Renderer console → terminal (dev visibility)
	if (!env.isPackaged) {
		win.webContents.on('console-message', (e, level, message) => { console.log('stage :', message); });
	}

	Menu.setApplicationMenu(null);
}

// File association (.md/.markdown) in HKCU — per-user, no admin needed.
// Squirrel installs per-user, so this matches the install scope.
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
	for (const [key, ...rest] of cmds) {
		const child = spawn('reg', ['add', key, ...rest, '/f'], { windowsHide: true });
		child.on('error', err => console.error('main : file association failed for', key, err.message));
	}
}
