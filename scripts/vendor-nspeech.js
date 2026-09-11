// Vendors the canonical nSpeech client SDK from the nSpeech repo into
// app/js/lib/. Zero-dep (Node 18+ global fetch). Run: npm run vendor:nspeech
//
// Source of truth: https://github.com/herrbasan/nSpeech
//   lib/nspeech-client/nspeech-client.js  →  app/js/lib/nspeech-client.js

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = 'https://raw.githubusercontent.com/herrbasan/nSpeech/main/lib/nspeech-client/nspeech-client.js';
const DEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'js', 'lib', 'nspeech-client.js');

const res = await fetch(SRC);
if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} ${SRC}`);
const body = await res.text();
if (!body.includes('NSpeechClient') || !body.includes('SpeechPlayer')) {
	throw new Error('fetched file does not look like the nSpeech SDK — refusing to write');
}
await writeFile(DEST, body, 'utf8');
const sha = createHash('sha256').update(body).digest('hex').slice(0, 12);
console.log(`vendored ${DEST}`);
console.log(`${body.length} bytes, sha256:${sha}`);
