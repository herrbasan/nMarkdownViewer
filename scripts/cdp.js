'use strict';

// Zero-dep CDP client for the dev Electron shell. The unpackaged app opens
// Chromium's remote debugging port (9222) — see app/js/main.js — so agents
// and humans can observe the REAL shell (files, raum://, prefs.json) instead
// of reasoning from the browser harness, which shares none of those.
//
//   node scripts/cdp.js --list
//   node scripts/cdp.js --eval "document.title" [--url <substr>]
//   node scripts/cdp.js --shot out/screenshot.png [--url <substr>]
//
// --url picks a target when several windows are open (linked documents open
// their own BrowserWindow — each is a separate CDP page target).
// Native WebSocket requires Node >= 22. Override the port with NMDV_CDP_PORT.

const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.NMDV_CDP_PORT || 9222;
const TIMEOUT_MS = 15000;

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json`);
	if (!res.ok) throw new Error(`CDP endpoint HTTP ${res.status} — is the dev app running (npx electron-forge start)?`);
	return res.json();
}

function pickPage(list, urlMatch) {
	const pages = list.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
	if (urlMatch) {
		const hit = pages.find(t => t.url.includes(urlMatch) || t.title.includes(urlMatch));
		if (!hit) throw new Error(`No page matching "${urlMatch}". Open pages: ${pages.map(p => `${p.title} (${p.url})`).join(', ') || 'none'}`);
		return hit;
	}
	if (!pages.length) throw new Error('No page targets — is the app window up?');
	return pages[0];
}

// One-shot CDP session: connect, run commands, close. Sessions are cheap;
// a persistent one would only add a stale-state failure mode.
async function run(pageUrl, commands) {
	const ws = new WebSocket(pageUrl);
	let seq = 0;
	const pending = new Map();

	const done = new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('WebSocket failed — port reachable but page gone?')), { once: true });
	});
	const timer = setTimeout(() => {
		ws.close();
		console.error(`Timed out after ${TIMEOUT_MS}ms waiting on CDP.`);
		process.exit(2);
	}, TIMEOUT_MS);

	ws.addEventListener('message', (ev) => {
		const msg = JSON.parse(ev.data);
		if (!msg.id || !pending.has(msg.id)) return; // events are ignored
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
	});

	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});

	await done;
	try {
		for (const cmd of commands) await cmd(send);
	} finally {
		clearTimeout(timer);
		ws.close();
	}
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (name) => {
		const i = args.indexOf(name);
		return i === -1 ? null : args[i + 1];
	};
	const urlMatch = flag('--url');

	if (args.includes('--list')) {
		for (const t of await targets()) {
			console.log(`${t.type.padEnd(8)} ${t.title}  —  ${t.url}`);
		}
		return;
	}

	const exprArg = flag('--eval');
	const exprFile = flag('--eval-file');
	// Complex probes go in a FILE — quoting a multi-line script through a
	// shell command line re-parses it and breaks in ways that blame the JS.
	const expr = exprArg || (exprFile ? fs.readFileSync(exprFile, 'utf8') : null);
	const shot = flag('--shot');
	if (!expr && !shot) {
		console.log('Usage: node scripts/cdp.js --list | --eval <js> | --shot <file.png> [--url <substr>]');
		process.exit(1);
	}

	const page = pickPage(await targets(), urlMatch);
	await run(page.webSocketDebuggerUrl, [
		...(expr ? [async (send) => {
			const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
			if (r.exceptionDetails) {
				const e = r.exceptionDetails;
				throw new Error(`Eval threw: ${e.exception?.description || e.text}`);
			}
			console.log(JSON.stringify(r.result.value ?? r.result, null, 1));
		}] : []),
		...(shot ? [async (send) => {
			const r = await send('Page.captureScreenshot', { format: 'png' });
			const out = path.resolve(shot);
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
			console.log(`Wrote ${out} (${fs.statSync(out).size} bytes)`);
		}] : [])
	]);
}

main().catch(err => {
	console.error(err.message);
	process.exit(1);
});
