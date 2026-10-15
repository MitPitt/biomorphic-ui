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

/** Separable box blur, O(n) via a sliding window (clamped edges). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	const win = 2 * r + 1;
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let sum = 0;
		for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
		for (let x = 0; x < w; x++) {
			tmp[row + x] = sum / win;
			sum -= src[row + Math.min(w - 1, Math.max(0, x - r))];
			sum += src[row + Math.min(w - 1, Math.max(0, x + r + 1))];
		}
	}
	for (let x = 0; x < w; x++) {
		let sum = 0;
		for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = sum / win;
			sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
			sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
		}
	}
	return out;
}

/**
 * Smoothed outward-normal field plus a spare channel (RGBA). The distance field
 * is blurred before differencing so the direction fans smoothly around convex
 * corners instead of flipping across the medial-axis shock. Returns (nx, ny, 0, 0).
 */
export function normalField(ctx: SeedCtx, radius: number): Float32Array {
	const { w, h } = ctx;
	const d = distanceField(ctx);
	const r = Math.max(1, Math.round(radius));
	let s = boxBlur(d, w, h, r);
	s = boxBlur(s, w, h, r);

	const out = new Float32Array(w * h * 4);
	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			const i = gy * w + gx;
			const xl = gx > 0 ? s[i - 1] : s[i];
			const xr = gx < w - 1 ? s[i + 1] : s[i];
			const yd = gy > 0 ? s[i - w] : s[i];
			const yu = gy < h - 1 ? s[i + w] : s[i];
			let nx = xr - xl;
			let ny = yu - yd;
			const len = Math.hypot(nx, ny);
			if (len > 1e-6) {
				nx /= len;
				ny /= len;
			} else {
				nx = 0;
				ny = 1;
			}
			out[i * 4] = nx;
			out[i * 4 + 1] = ny;
		}
	}
	return out;
}
