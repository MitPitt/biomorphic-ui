/**
 * Glyph masks for `data-shape="text"` targets.
 *
 * The browser's own layout and fonts are the source of truth: every character is
 * measured with a DOM Range (so wrapping, inline styles and letter-spacing are
 * already resolved) and drawn into an offscreen canvas with the same computed
 * font. The alpha channel is then sampled per grid cell, turning the text into
 * substrate without parsing a font file or shipping one.
 */

import { chamfer } from './fields';

export interface TextMask {
	/** Document-space origin of the mask. */
	x: number;
	y: number;
	/** Mask dimensions in CSS px. */
	w: number;
	h: number;
	/** Device pixels per CSS px in `data`. */
	scale: number;
	pw: number;
	ph: number;
	/** RGBA pixels, alpha in `[3]`. */
	data: Uint8ClampedArray;
	/** Signature of the glyph inputs (text, fonts, positions, scale). */
	key: number;
	/** Lazily built distance fields for inward/outward offsets. */
	cov?: Uint8Array;
	erode?: Float32Array;
	dilate?: Float32Array;
}

interface Glyph {
	ch: string;
	/** Local document px, origin at the mask's top-left. */
	x: number;
	top: number;
	lineHeight: number;
	ascent: number;
	descent: number;
	font: string;
	/** DOM advance / canvas advance, compensating mobile font autosizing. */
	k: number;
}

const cache = new WeakMap<HTMLElement, TextMask>();

/** FNV-1a over a string, folded into an existing hash. */
function mixString(hash: number, s: string): number {
	let h = hash;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h;
}

/** Font shorthand for a canvas context from a computed style. */
function fontOf(style: CSSStyleDeclaration): string {
	return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** Collect every visible character with its document position and computed font. */
function glyphsOf(el: HTMLElement, x: number, y: number): { glyphs: Glyph[]; key: number } {
	const glyphs: Glyph[] = [];
	// key includes the box and scale-independent glyph inputs; positions are mixed
	// as they are read, so a reflow inside the same box still rebuilds the mask
	let key = 2166136261;
	let pxPerDoc = 1;
	let wordStart = true;
	const styles = new Map<Element, CSSStyleDeclaration>();
	const scratch = document.createElement('canvas').getContext('2d');
	const scrollX = window.scrollX;
	const scrollY = window.scrollY;

	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	while (node) {
		const parent = node.parentElement;
		if (!parent) {
			node = walker.nextNode() as Text | null;
			continue;
		}
		if (!node.data.trim()) {
			wordStart = true;
			node = walker.nextNode() as Text | null;
			continue;
		}
		let style = styles.get(parent);
		if (!style) {
			style = getComputedStyle(parent);
			styles.set(parent, style);
		}
		const font = fontOf(style);
		key = mixString(key, font);
		key = mixString(key, style.textTransform);
		if (scratch) {
			scratch.font = font;
			if ('fontVariantCaps' in scratch) {
				scratch.fontVariantCaps = style.fontVariantCaps as CanvasFontVariantCaps;
			}
			const metrics = scratch.measureText('Hg');
			const fontSize = parseFloat(style.fontSize) || 16;
			const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
			const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
			const spacing = parseFloat(style.letterSpacing);
			const letter = Number.isFinite(spacing) ? spacing : 0;
			const text = node.data;
			for (let i = 0; i < text.length; ) {
				const cp = text.codePointAt(i)!;
				let ch = String.fromCodePoint(cp);
				const next = i + ch.length;
				// canvas draws the raw textContent, so apply the CSS transform the
				// layout used (e.g. an uppercase heading whose source is lowercase)
				if (style.textTransform === 'uppercase') ch = ch.toUpperCase();
				else if (style.textTransform === 'lowercase') ch = ch.toLowerCase();
				else if (style.textTransform === 'capitalize' && wordStart) ch = ch.toUpperCase();
				wordStart = /\s/.test(ch);
				key = mixString(key, ch);
				if (ch.trim()) {
					const range = document.createRange();
					range.setStart(node, i);
					range.setEnd(node, next);
					const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
					if (r && r.width > 0 && r.height > 0) {
						const gx = r.left + scrollX - x;
						const top = r.top + scrollY - y;
						pxPerDoc = Math.max(pxPerDoc, window.devicePixelRatio || 1);
						key ^= Math.round(gx * 10);
						key = Math.imul(key, 16777619);
						key ^= Math.round(top * 10);
						key = Math.imul(key, 16777619);
						key ^= Math.round(r.height * 10);
						key = Math.imul(key, 16777619);
						// The DOM advance is the used (possibly autosized) font; the canvas
						// font string is the computed one. Scale by their ratio so the mask
						// matches the rendered text (letter-spacing is included in r.width).
						const natural = scratch.measureText(ch).width;
						const advance = r.width - letter;
						const k = natural > 0.01 && advance > 0 ? Math.min(3, Math.max(0.5, advance / natural)) : 1;
						glyphs.push({ ch, x: gx, top, lineHeight: r.height, ascent, descent, font, k });
					}
				}
				i = next;
			}
		}
		node = walker.nextNode() as Text | null;
	}
	key ^= Math.round(pxPerDoc * 100);
	key = Math.imul(key, 16777619);
	return { glyphs, key };
}

/**
 * Build (or reuse) the glyph mask for a text target.
 *
 * `x,y,w,h` are the target's document-space box. `pad` grows the mask canvas
 * beyond that box so an outward offset can be sampled without clipping at the
 * element's edge. The mask is capped in pixel count so a giant text block cannot
 * blow up memory.
 */
export function textMaskOf(el: HTMLElement, x: number, y: number, w: number, h: number, pad = 0): TextMask {
	const mx = x - pad;
	const my = y - pad;
	const mw = w + pad * 2;
	const mh = h + pad * 2;
	const { glyphs, key: glyphKey } = glyphsOf(el, mx, my);
	let key = glyphKey;
	key = mixString(key, `${Math.round(mx * 10)},${Math.round(my * 10)},${Math.round(mw * 10)},${Math.round(mh * 10)}`);
	const prev = cache.get(el);
	if (prev && prev.key === key) return prev;

	let scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
	const area = Math.max(1, mw * mh);
	const maxPixels = 4_000_000;
	const maxDim = 4096;
	if (area * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / area);
	scale = Math.min(scale, maxDim / Math.max(1, mw), maxDim / Math.max(1, mh));
	const pw = Math.max(1, Math.min(maxDim, Math.round(mw * scale)));
	const ph = Math.max(1, Math.min(maxDim, Math.round(mh * scale)));

	const canvas = document.createElement('canvas');
	canvas.width = pw;
	canvas.height = ph;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const mask: TextMask = { x: mx, y: my, w: mw, h: mh, scale, pw, ph, data: new Uint8ClampedArray(pw * ph * 4), key };
	if (ctx && glyphs.length) {
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = '#fff';
		let font = '';
		for (const g of glyphs) {
			if (g.font !== font) {
				ctx.font = g.font;
				font = g.font;
			}
			const ascent = g.ascent * g.k;
			const descent = g.descent * g.k;
			const lineHeight = Math.max(g.lineHeight, ascent + descent);
			const baseline = g.top + (lineHeight - (ascent + descent)) / 2 + ascent;
			const glyphScale = scale * g.k;
			ctx.save();
			ctx.translate(g.x * scale, baseline * scale);
			ctx.scale(glyphScale, glyphScale);
			ctx.fillText(g.ch, 0, 0);
			ctx.restore();
		}
		try {
			mask.data = ctx.getImageData(0, 0, pw, ph).data;
		} catch (err) {
			console.error('[bio] text mask read failed', err);
		}
	}
	cache.set(el, mask);
	return mask;
}

function coverageOf(mask: TextMask): Uint8Array {
	if (!mask.cov) {
		const cov = new Uint8Array(mask.pw * mask.ph);
		const data = mask.data;
		for (let i = 0, j = 3; i < cov.length; i++, j += 4) cov[i] = data[j] > 24 ? 1 : 0;
		mask.cov = cov;
	}
	return mask.cov;
}

/** Coverage eroded by `px` CSS px: distance from each glyph pixel to the outside. */
function erodeDist(mask: TextMask): Float32Array {
	if (!mask.erode) {
		const cov = coverageOf(mask);
		const inv = new Uint8Array(cov.length);
		for (let i = 0; i < cov.length; i++) inv[i] = cov[i] ? 0 : 1;
		mask.erode = chamfer(inv, mask.pw, mask.ph);
	}
	return mask.erode;
}

/** Coverage dilated by `px` CSS px: distance from each pixel to the nearest glyph. */
function dilateDist(mask: TextMask): Float32Array {
	if (!mask.dilate) mask.dilate = chamfer(coverageOf(mask), mask.pw, mask.ph);
	return mask.dilate;
}

/**
 * True if the grid cell centred at `px,py` intersects the glyph mask.
 * `cell` is in CSS px; the whole cell area is sampled so a one-pixel stem still
 * marks the cells it crosses. `offset` is a signed CSS-px adjustment: positive
 * pushes the glyph substrate inward (erode), negative pushes it outward (dilate).
 */
export function textMaskHas(mask: TextMask, px: number, py: number, cell: number, offset = 0): boolean {
	const s = mask.scale;
	const x0 = Math.max(0, Math.floor((px - cell / 2 - mask.x) * s));
	const x1 = Math.min(mask.pw - 1, Math.ceil((px + cell / 2 - mask.x) * s));
	const y0 = Math.max(0, Math.floor((py - cell / 2 - mask.y) * s));
	const y1 = Math.min(mask.ph - 1, Math.ceil((py + cell / 2 - mask.y) * s));
	const r = Math.abs(offset) * s;
	if (offset > 0) {
		const d = erodeDist(mask);
		for (let y = y0; y <= y1; y++) {
			let i = y * mask.pw + x0;
			for (let x = x0; x <= x1; x++, i++) if (d[i] >= r) return true;
		}
		return false;
	}
	if (offset < 0) {
		const d = dilateDist(mask);
		for (let y = y0; y <= y1; y++) {
			let i = y * mask.pw + x0;
			for (let x = x0; x <= x1; x++, i++) if (d[i] <= r) return true;
		}
		return false;
	}
	for (let y = y0; y <= y1; y++) {
		let i = (y * mask.pw + x0) * 4 + 3;
		for (let x = x0; x <= x1; x++, i += 4) {
			if (mask.data[i] > 24) return true;
		}
	}
	return false;
}
