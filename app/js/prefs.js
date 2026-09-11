'use strict';

// Persistent app preferences (TTS engine/voice/speed, startup folder, …).
//
// Electron: JSON file at <userData>/prefs.json — same pattern as
// window-state.json in the main process. localStorage is NOT reliable there
// (file:// origin, portable runs) — settings were lost on every app start.
// Browser: localStorage (per-origin, survives restarts under scripts/serve.js).
//
// Sync get/set on an in-memory map; writes are debounced (250ms) and
// best-effort flushed on pagehide. A corrupt prefs file throws at init
// (fail loud) — delete the file to reset.

const LS_KEY = 'nmdv-prefs';
const FLUSH_MS = 250;

let data = {};
let filePath = null; // Electron only
let flushTimer = null;

async function writeThrough() {
	const json = JSON.stringify(data, null, '\t');
	if (filePath) {
		await window.nmdv_node.fsp.writeFile(filePath, json, 'utf8');
	} else {
		localStorage.setItem(LS_KEY, json);
	}
}

function scheduleFlush() {
	clearTimeout(flushTimer);
	flushTimer = setTimeout(() => {
		writeThrough().catch(err => console.error('nmdv: prefs write failed:', err));
	}, FLUSH_MS);
}

export const prefs = {
	// userDataPath: Electron env.userData from the main process; falsy = browser.
	async init(userDataPath) {
		if (userDataPath && window.nmdv_node) {
			filePath = window.nmdv_node.path.join(userDataPath, 'prefs.json');
			try {
				data = JSON.parse(await window.nmdv_node.fsp.readFile(filePath, 'utf8'));
			} catch (err) {
				if (err.code !== 'ENOENT') throw new Error(`prefs.json unreadable (${err.message}) — delete it to reset`);
				data = {}; // first run
			}
		} else {
			data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
			// One-time migration from the old per-key TTS storage
			if (!Object.keys(data).length) {
				for (let i = 0; i < localStorage.length; i++) {
					const k = localStorage.key(i);
					if (k?.startsWith('nmdv-tts-')) data[k] = localStorage.getItem(k);
				}
			}
		}
	},
	get(key) { return data[key]; },
	set(key, value) { data[key] = value; scheduleFlush(); },
	remove(key) { delete data[key]; scheduleFlush(); },
	flush() { clearTimeout(flushTimer); return writeThrough(); }
};

// Best-effort final write — pagehide cannot await, but the pending write
// usually lands during teardown. Failures surface via console (trace, never
// silent).
window.addEventListener('pagehide', () => {
	if (flushTimer !== null) prefs.flush().catch(() => {});
});
