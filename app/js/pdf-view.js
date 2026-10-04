'use strict';

// In-app PDF rendering. Chromium's own viewer is unavailable here (see
// file-types.js), so this draws the document itself with pdf.js — a RENDERER,
// not a browser plugin, which is why it works at all.
//
// One canvas per page, rendered lazily as it scrolls into view, plus a
// transparent text layer over each so text is selectable and findable. The
// toolbar is our own elements; no NUI component is styled.

// Vendored pdf.js 4.10.38 (Apache-2.0), not 6.x: the 6 series calls
// Math.sumPrecise, an ES2025 built-in that Electron 41's V8 does not ship.
// The call site is inside the WORKER, which has its own global scope, so a
// shim in this module cannot reach it — the version has to be the compatible
// one. Nothing here needs a polyfill; nothing needs patching.
import * as pdfjs from '../modules/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../modules/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const CMAP_URL = new URL('../modules/pdfjs/cmaps/', import.meta.url).href;
const FONT_URL = new URL('../modules/pdfjs/standard_fonts/', import.meta.url).href;

export class PdfView {
	// `bytes` is a Uint8Array, NOT a URL: fetch() over the raum:// protocol is
	// CORS-blocked from a file:// origin, and handing pdf.js a URL it cannot
	// fetch would fail the same way.
	constructor(host, bytes, name) {
		this.host = host;
		this.bytes = bytes;
		this.name = name;
		this.doc = null;
		this.scale = 1;
		this.fitMode = 'width';
		this.pages = [];        // { page, canvas, wrap, textLayer, rendered, task, render }
		this.token = 0;         // guards async work against a document change
		this.wantScale = null;  // latest zoom intent, while a re-render runs
		this.scaling = null;    // the in-flight coalescing loop
	}

	// A view that outlives its document keeps rendering into a detached
	// host — and two live views racing on the same canvas is exactly the
	// "multiple render() operations" throw. Every observer is stopped here.
	destroy() {
		this.token++;
		this.wantScale = null;
		this.scaling = null;
		this.io?.disconnect();
		this.ro?.disconnect();
		for (const p of this.pages) {
			p.render?.cancel?.();
			p.task = null;
		}
		this.pages = [];
		this.doc?.destroy?.();
		this.doc = null;
		this.destroyed = true;
	}

	async mount() {
		if (this.destroyed) return;
		this.buildChrome();
		this.doc = await pdfjs.getDocument({
			data: this.bytes,
			cMapUrl: CMAP_URL,
			cMapPacked: true,
			standardFontDataUrl: FONT_URL
		}).promise;
		// The chrome is built before the document exists, so the total is
		// still the placeholder at this point — fill it in now.
		this.of.textContent = this.doc.numPages;

		this.first = await this.doc.getPage(1);
		this.baseScale = this.first.getViewport({ scale: 1 }).width;

		// Pages first, THEN the scale: fit-width measures the scroller, and
		// the scroller only has its real width once the page boxes exist.
		// Measuring before that produced a 224% "fit".
		this.createPages();
		this.setScale(this.fitScale(), 'width');
		await this.renderAll();
		this.observe();
		// Explicit, not derived: onScroll measures against page boxes, and
		// guessing from geometry at mount time once reported page 42 of 84 on
		// a freshly opened document.
		this.current = 1;
		this.pageInput.value = '1';
		this.watchResize();
	}

	// A viewer that does not refit when its pane changes is wrong twice over:
	// the first measurement lands before layout settles, and resizing the
	// window would leave the page stranded at the old scale. Only a manual
	// zoom is left alone — that one the user chose.
	watchResize() {
		let frame = 0;
		this.ro?.disconnect();
		this.ro = new ResizeObserver(() => {
			if (this.fitMode === 'manual') return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(async () => {
				if (!this.pages.length || !this.doc) return;
				const fit = this.fitScale();
				// Ignore sub-pixel churn; only a real change re-renders.
				if (Math.abs(fit - this.scale) < 0.005) return;
				await this.applyScale(fit, this.fitMode);
			});
		});
		this.ro.observe(this.scroller);
	}

	// The scroll container, minus the chrome, is what a page must fit into.
	fitScale() {
		const avail = this.scroller.clientWidth - 2;
		return this.fitMode === 'page'
			? Math.min(avail / this.baseScale, (this.scroller.clientHeight - 2) / (this.baseScale * 1.414))
			: avail / this.baseScale;
	}

	buildChrome() {
		this.host.classList.add('pdf-view');
		// Three groups: navigation, zoom, and the fit toggle pushed right.
		// Everything is a borderless icon button except Fit — a toolbar of
		// filled primary buttons shouts louder than the document it sits over.
		this.host.innerHTML = `
			<div class="pdf-bar">
				<div class="pdf-group">
					<nui-button variant="icon"><button type="button" data-pdf="prev" aria-label="Previous page" title="Previous page">‹</button></nui-button>
					<span class="pdf-count">
						<nui-input><input type="text" inputmode="numeric" aria-label="Page number"></nui-input>
						<span class="pdf-of" data-pdf="of">–</span>
					</span>
					<nui-button variant="icon"><button type="button" data-pdf="next" aria-label="Next page" title="Next page">›</button></nui-button>
				</div>
				<div class="pdf-group">
					<nui-button variant="icon"><button type="button" data-pdf="zoom-out" aria-label="Zoom out" title="Zoom out">−</button></nui-button>
					<span class="pdf-zoom" data-pdf="zoom" title="Reset to 100%">100%</span>
					<nui-button variant="icon"><button type="button" data-pdf="zoom-in" aria-label="Zoom in" title="Zoom in">+</button></nui-button>
				</div>
				<div class="pdf-group pdf-far">
					<nui-button variant="ghost"><button type="button" data-pdf="fit" aria-label="Toggle fit"></button></nui-button>
				</div>
			</div>
			<div class="pdf-scroll" data-pdf="scroll"></div>`;
		this.scroller = this.host.querySelector('[data-pdf="scroll"]');
		this.bar = this.host.querySelector('.pdf-bar');
		this.of = this.host.querySelector('[data-pdf="of"]');
		this.pageInput = this.host.querySelector('.pdf-count input');
		this.zoomLabel = this.host.querySelector('[data-pdf="zoom"]');
		this.fitLabel = this.host.querySelector('[data-pdf="fit"]');
		this.of.textContent = this.doc ? this.doc.numPages : '–';
		this.setFitLabel();

		this.host.addEventListener('click', async (e) => {
			const act = e.target.closest('[data-pdf]')?.dataset.pdf;
			if (!act) return;
			if (act === 'prev') await this.goToPage(this.current - 1);
			if (act === 'next') await this.goToPage(this.current + 1);
			if (act === 'zoom-in') await this.zoomBy(1.25);
			if (act === 'zoom-out') await this.zoomBy(1 / 1.25);
			if (act === 'fit') {
				this.fitMode = this.fitMode === 'width' ? 'page' : 'width';
				await this.applyScale(this.fitScale(), this.fitMode);
			}
		});
		this.zoomLabel.addEventListener('click', () => this.applyScale(1, 'manual'));
		this.pageInput.addEventListener('change', () => this.goToPage(parseInt(this.pageInput.value, 10) || 1));
		this.pageInput.addEventListener('focus', () => this.pageInput.select());
		this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
	}

	setFitLabel() {
		this.fitLabel.textContent = this.fitMode === 'page' ? 'Fit page' : 'Fit width';
	}

	// One box per page, sized but not yet drawn. The IntersectionObserver
	// paints the ones near the viewport.
	createPages() {
		this.scroller.innerHTML = '';
		this.pages = [];
		for (let n = 1; n <= this.doc.numPages; n++) {
			const wrap = document.createElement('div');
			wrap.className = 'pdf-page-wrap';
			wrap.dataset.page = n;
			const canvas = document.createElement('canvas');
			canvas.className = 'pdf-canvas';
			// The text layer is what the user selects; the canvas is the ink.
			const text = document.createElement('div');
			text.className = 'pdf-text';
			wrap.append(canvas, text);
			this.scroller.appendChild(wrap);
			this.pages.push({ n, wrap, canvas, text, rendered: false, page: null });
		}
	}

	async renderAll() {
		const token = ++this.token;
		await Promise.all(this.pages.map(p => this.ensurePage(p)));
		if (token !== this.token) return;
	}
	async ensurePage(entry) {
		if (!this.doc) return;
		// A render already in flight for this page is THE render to await.
		// pdf.js refuses two concurrent render() calls on one canvas, and
		// "rendered" is only set once the promise resolves — so without this
		// two callers (the observer and a re-render) both start, and the
		// second throws "Cannot use the same canvas during multiple
		// render() operations".
		if (entry.task) return entry.task;
		if (entry.rendered) return;

		const token = this.token;
		entry.task = (async () => {
			const page = await this.doc.getPage(entry.n);
			if (token !== this.token) return;
			const viewport = page.getViewport({ scale: this.scale });
			const dpr = window.devicePixelRatio || 1;

			entry.canvas.width = Math.floor(viewport.width * dpr);
			entry.canvas.height = Math.floor(viewport.height * dpr);
			entry.canvas.style.width = Math.floor(viewport.width) + 'px';
			entry.canvas.style.height = Math.floor(viewport.height) + 'px';
			entry.wrap.style.height = Math.floor(viewport.height) + 8 + 'px';

			const ctx = entry.canvas.getContext('2d', { alpha: false });
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, viewport.width, viewport.height);
			// 4.x takes canvasContext; the `canvas` key is a 5.x parameter and
			// sends 4.x down a Node-only path ("canvas is not defined").
			// The RenderTask is kept so a re-render can CANCEL it — cancelling
			// is asynchronous, and starting the next render before the last
			// has actually stopped is the "same canvas during multiple
			// render() operations" throw.
			entry.render = page.render({ canvasContext: ctx, viewport });
			await entry.render.promise;
			entry.rendered = true;
			entry.page = page;
			await this.paintText(entry, page, viewport);
		})().finally(() => { entry.task = null; entry.render = null; });

		return entry.task;
	}

	// A transparent text layer over the canvas. Without it the page is a
	// picture: nothing selectable, nothing searchable, nothing copyable.
	async paintText(entry, page, viewport) {
		const content = await page.getTextContent();
		entry.text.innerHTML = '';
		entry.text.style.width = Math.floor(viewport.width) + 'px';
		entry.text.style.height = Math.floor(viewport.height) + 'px';
		const [a, b, c, d, e, f] = viewport.transform;
		for (const item of content.items) {
			if (!item.str) continue;
			const span = document.createElement('span');
			span.textContent = item.str;
			const tx = pdfjs.Util.transform(viewport.transform, item.transform);
			const size = Math.hypot(tx[2], tx[3]);
			span.style.left = tx[4] + 'px';
			span.style.top = (tx[5] - size) + 'px';
			span.style.fontSize = size + 'px';
			span.style.fontFamily = item.fontName || 'sans-serif';
			// Rotate only when the text is actually rotated; a non-zero angle
			// here would tilt every glyph on an upright page.
			const angle = Math.atan2(tx[1], tx[0]);
			if (Math.abs(angle) > 0.01) span.style.transform = `rotate(${angle}rad)`;
			entry.text.appendChild(span);
		}
	}

	setScale(scale, mode) {
		this.scale = Math.min(Math.max(scale, 0.1), 8);
		this.fitMode = mode;
		this.zoomLabel.textContent = Math.round(this.scale * 100) + '%';
		this.setFitLabel();
	}
	// Only the pages in view are drawn; the rest get a blank box until they
	// scroll near, which keeps a 400-page document at a few MB of memory.
	observe() {
		this.io?.disconnect();
		this.io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const entry = this.pages.find(p => p.wrap === e.target);
				// Swallow a render failure here: this observer is not a place
				// to report one, and an escaping rejection surfaces as an
				// unhandled promise in the console with no document context.
				if (entry && !entry.rendered) this.ensurePage(entry).catch(() => {});
			}
		}, { root: this.scroller, rootMargin: '400px 0px' });
		for (const p of this.pages) this.io.observe(p.wrap);
	}

	onScroll() {
		const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
		let best = 1, bestD = Infinity;
		for (const p of this.pages) {
			const midPage = p.wrap.offsetTop + p.wrap.offsetHeight / 2;
			const d = Math.abs(mid - midPage);
			if (d < bestD) { bestD = d; best = p.n; }
		}
		this.current = best;
		this.pageInput.value = String(best);
	}

	async goToPage(n) {
		const target = Math.min(Math.max(n, 1), this.doc?.numPages ?? 1);
		const entry = this.pages.find(p => p.n === target);
		if (!entry) return;
		await this.ensurePage(entry);
		entry.wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
		this.current = target;
		this.pageInput.value = String(target);
	}

	async zoomBy(factor) {
		await this.applyScale(this.scale * factor, 'manual');
	}

	// A canvas is rasterised at a fixed size, so every scale change is a full
	// re-render — and a burst of zoom clicks arrives far faster than 84 pages
	// can re-render. So: the latest intent WINS. A re-render in flight is left
	// to finish, then the final scale is applied once. Queueing every
	// intermediate step would replay the whole burst and still land in the
	// right place, just seconds later.
	async applyScale(scale, mode) {
		this.setScale(scale, mode);
		if (!this.pages.length) return;      // pre-layout; mount() renders
		this.wantScale = scale;
		if (this.scaling) return this.scaling;

		this.scaling = (async () => {
			while (this.wantScale !== null && !this.destroyed) {
				this.wantScale = null;
				await this.reRender();
			}
		})().finally(() => { this.scaling = null; });

		return this.scaling;
	}

	// Re-render at the new scale. pdf.js cannot rescale a finished canvas.
	// Every in-flight render is cancelled AND awaited before a new one
	// starts: cancel() is asynchronous, so merely calling it leaves the old
	// render holding the canvas for another frame or two.
	async reRender() {
		const pending = this.pages.filter(p => p.task).map(p => p.task.catch(() => {}));
		for (const p of this.pages) {
			p.render?.cancel?.();
			p.task = null;
			p.render = null;
			p.rendered = false;
		}
		await Promise.allSettled(pending);
		if (this.destroyed) return;
		await this.renderAll();
		this.observe();
	}}
