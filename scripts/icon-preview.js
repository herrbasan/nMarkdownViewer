'use strict';
// Generate an HTML preview of build/icons/md.ico (light + dark backgrounds)
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ico = fs.readFileSync(path.join(root, 'build/icons/md.ico'));
const count = ico.readUInt16LE(4);
const pngs = [];
for (let i = 0; i < count; i++) {
	const off = 6 + 16 * i;
	pngs.push({
		size: ico.readUInt8(off),
		b64: ico.slice(ico.readUInt32LE(off + 12), ico.readUInt32LE(off + 12) + ico.readUInt32LE(off + 8)).toString('base64')
	});
}

const cells = pngs.map(p =>
	`<td style="padding:8px"><img src="data:image/png;base64,${p.b64}" width="${p.size}" height="${p.size}"><br>${p.size}px</td>`
).join('');

const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;margin:24px">
<h3>md.ico preview</h3>
<table style="text-align:center"><tr>${cells}</tr></table>
<div style="display:flex;gap:24px;margin-top:24px;align-items:center">
<div style="background:#fff;padding:24px;border:1px solid #ccc">light<br><img src="data:image/png;base64,${pngs[3].b64}"></div>
<div style="background:#1e1e1e;padding:24px;color:#ccc">dark<br><img src="data:image/png;base64,${pngs[3].b64}"></div>
</div></body></html>`;

fs.writeFileSync(path.join(root, 'out/_icon-preview.html'), html);
console.log('preview written');
