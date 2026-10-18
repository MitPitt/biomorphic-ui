import type { SeedCtx } from './types';

/** Chamfer (near-Euclidean) distance to the nearest set cell in `mask`. */
export function chamfer(mask: Uint8Array, w: number, h: number): Float32Array {
	const f = new Float32Array(w * h);
	const INF = 1e9;
	const D = Math.SQRT2;
	for (let i = 0; i < w * h; i++) f[i] = mask[i] ? 0 : INF;

	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			const i = gy * w + gx;
			let v = f[i];
			if (gx > 0) v = Math.min(v, f[i - 1] + 1);
			if (gy > 0) v = Math.min(v, f[i - w] + 1);
			if (gx > 0 && gy > 0) v = Math.min(v, f[i - w - 1] + D);
			if (gx < w - 1 && gy > 0) v = Math.min(v, f[i - w + 1] + D);
			f[i] = v;
		}
	}
	for (let gy = h - 1; gy >= 0; gy--) {
		for (let gx = w - 1; gx >= 0; gx--) {
			const i = gy * w + gx;
			let v = f[i];
			if (gx < w - 1) v = Math.min(v, f[i + 1] + 1);
			if (gy < h - 1) v = Math.min(v, f[i + w] + 1);
			if (gx < w - 1 && gy < h - 1) v = Math.min(v, f[i + w + 1] + D);
			if (gx > 0 && gy < h - 1) v = Math.min(v, f[i + w - 1] + D);
			f[i] = v;
		}
	}
	return f;
}

/** Euclidean distance-to-substrate (chamfer, two pass). */
export function distanceField(ctx: SeedCtx): Float32Array {
	return chamfer(ctx.substrate, ctx.w, ctx.h);
}

/** Separable box blur, O(n) via a sliding window (clamped edges). `out`/`tmp`
 * may be supplied to reuse buffers across calls (`tmp` must not alias `src`).
 * Clamped edge indices are precomputed into tables so the inner loops do no
 * per-element `Math.min/max` (that was the field-build hotspot). */
export function boxBlur(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
	out?: Float32Array,
	tmp?: Float32Array,
): Float32Array {
	tmp = tmp ?? new Float32Array(w * h);
	out = out ?? new Float32Array(w * h);
	const win = 2 * r + 1;
	// index k (which may be out of range by up to r) -> clamped coordinate
	const xc = new Int32Array(w + 2 * r + 2);
	for (let k = 0; k < xc.length; k++) xc[k] = k - r < 0 ? 0 : k - r >= w ? w - 1 : k - r;
	const yc = new Int32Array(h + 2 * r + 2);
	for (let k = 0; k < yc.length; k++) yc[k] = k - r < 0 ? 0 : k - r >= h ? h - 1 : k - r;

	for (let y = 0; y < h; y++) {
		const row = y * w;
		let sum = 0;
		for (let k = 0; k <= 2 * r; k++) sum += src[row + xc[k]];
		for (let x = 0; x < w; x++) {
			tmp[row + x] = sum / win;
			sum -= src[row + xc[x]];
			sum += src[row + xc[x + 2 * r + 1]];
		}
	}
	for (let x = 0; x < w; x++) {
		let sum = 0;
		for (let k = 0; k <= 2 * r; k++) sum += tmp[yc[k] * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = sum / win;
			sum -= tmp[yc[y] * w + x];
			sum += tmp[yc[y + 2 * r + 1] * w + x];
		}
	}
	return out;
}

/**
 * Smoothed outward-normal field. The distance field is blurred before differencing
 * so the direction fans smoothly around convex corners instead of flipping across
 * the medial-axis shock. Returns a tightly packed (nx, ny) array — two floats per
 * cell, matching the RG16F `u_field` texture the engine uploads.
 */
export function normalField(ctx: SeedCtx, radius: number): Float32Array {
	const { w, h } = ctx;
	const d = distanceField(ctx);
	const r = Math.max(1, Math.round(radius));
	// blur twice, reusing scratch: the first pass blurs in place (its `out` aliases
	// `src`, which is safe — `out` is only written after `tmp` is filled), the second
	// writes a fresh buffer. Saves two full-grid allocations per reset.
	const tmp = new Float32Array(w * h);
	boxBlur(d, w, h, r, d, tmp);
	const s = boxBlur(d, w, h, r, new Float32Array(w * h), tmp);

	const out = new Float32Array(w * h * 2);
	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			const i = gy * w + gx;
			const xl = gx > 0 ? s[i - 1] : s[i];
			const xr = gx < w - 1 ? s[i + 1] : s[i];
			const yd = gy > 0 ? s[i - w] : s[i];
			const yu = gy < h - 1 ? s[i + w] : s[i];
			let nx = xr - xl;
			let ny = yu - yd;
			const len = Math.sqrt(nx * nx + ny * ny);
			if (len > 1e-6) {
				nx /= len;
				ny /= len;
			} else {
				nx = 0;
				ny = 1;
			}
			out[i * 2] = nx;
			out[i * 2 + 1] = ny;
		}
	}
	return out;
}
