'use strict';

// Zero-dependency static dev server for the browser-first phase.
// Serves the workspace root so /app/index.html can reach /config.json
// and /app/modules/nui_wc2. Not used by the Electron shell.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5581;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav'
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	let rel = decodeURIComponent(url.pathname);
	// Redirect to the real path so the browser resolves relative
	// URLs (css/, js/, modules/) against /app/, not /.
	if (rel === '/') {
		res.writeHead(302, { Location: '/app/' });
		res.end();
		return;
	}
	if (rel.endsWith('/')) rel += 'index.html';

	const fp = path.normalize(path.join(ROOT, rel));
	if (!fp.startsWith(ROOT)) {
		res.writeHead(403).end('Forbidden');
		return;
	}

	fs.stat(fp, (err, st) => {
		if (err || !st.isFile()) {
			res.writeHead(404).end('Not found: ' + rel);
			return;
		}
		const mime = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
		res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
		fs.createReadStream(fp).pipe(res);
	});
});

server.listen(PORT, () => {
	console.log(`nMarkdownViewer dev server: http://127.0.0.1:${PORT}/`);
});
