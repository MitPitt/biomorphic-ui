import { applyShapeCss, insideShape, shapeSpecOf, signedDistanceShape } from './shapes';
import type { ShapeSpec } from './shapes';
import { textMaskHas, textMaskOf } from './text';
import type { TextMask } from './text';
import type { ActivityMode, TargetSpec } from './types';

/** Grid geometry for one engine, shared by the DOM wrapper and the worker core. */
export interface GridLayout {
	/** Document size in CSS px (the canvas covers the whole document). */
	cssW: number;
	cssH: number;
	dpr: number;
	/** Canvas backing-store size in device px. */
	bw: number;
	bh: number;
	/** State grid size (cells). */
	w: number;
	h: number;
	/** CSS px per cell. */
	cellCss: number;
}

export function layoutFor(
	cssW: number,
	cssH: number,
	dpr: number,
	cellSize: number,
	maxCells: number,
	maxDim = 0,
): GridLayout {
	const fullW = Math.max(1, Math.round(cssW * dpr));
	const fullH = Math.max(1, Math.round(cssH * dpr));
	const area = fullW * fullH;
	const minCell = Math.sqrt(area / Math.max(1, maxCells));
	let cell = Math.max(cellSize, minCell);
	let w = Math.max(8, Math.round(fullW / cell));
	let h = Math.max(8, Math.round(fullH / cell));
	let bw = fullW;
	let bh = fullH;
	if (maxDim > 0) {
		maxDim = Math.max(8, maxDim);
		cell = Math.max(cell, Math.ceil(Math.max(fullW, fullH) / maxDim));
		w = Math.max(8, Math.round(fullW / cell));
		h = Math.max(8, Math.round(fullH / cell));
		const scale = Math.min(1, maxDim / fullW, maxDim / fullH);
		bw = Math.max(1, Math.round(fullW * scale));
		bh = Math.max(1, Math.round(fullH * scale));
	}
	return { cssW, cssH, dpr, bw, bh, w, h, cellCss: cssW / w };
}

/** One rasterizable element, fully precomputed on the main thread. */
export interface SceneTarget {
	mode: ActivityMode;
	own: boolean;
	spec: ShapeSpec;
	left: number;
	top: number;
	right: number;
	bottom: number;
	cx: number;
	cy: number;
	baseRx: number;
	baseRy: number;
	rx: number;
	ry: number;
	/** Cross-group gap applied to this target (0 for the group's own elements). */
	aura: number;
	/** Shape inset in CSS px (positive inward, negative outward). */
	inset: number;
	/** `inset - aura` (the actual offset used when painting). */
	offset: number;
	/** Outward padding the glyph mask was built with. */
	pad: number;
	mask: TextMask | null;
}

/** A reset's complete, structured-clone-safe description (no DOM references). */
export interface RasterScene extends GridLayout {
	targets: SceneTarget[];
	/** Engine-level aura, mixed into the field key like the old rasterizer did. */
	neighborAura: number;
}

function kindCode(spec: ShapeSpec): number {
	return spec.kind === 'rect' ? 0 : spec.kind === 'circle' ? 1 : spec.kind === 'polygon' ? 2 : spec.kind === 'star' ? 3 : 4;
}

/** Lightweight clone without the lazily built distance fields (safe to postMessage). */
function maskData(mask: TextMask): TextMask {
	return {
		x: mask.x,
		y: mask.y,
		w: mask.w,
		h: mask.h,
		scale: mask.scale,
		pw: mask.pw,
		ph: mask.ph,
		data: mask.data,
		key: mask.key,
	};
}

/**
 * Build a scene on the main thread: measure each target, sync its CSS shape and
 * capture text glyph masks. This is the only DOM-dependent part of a reset; the
 * expensive rasterization/field/seed work can then run in a worker.
 */
export function collectScene(
	layout: GridLayout,
	targets: Array<TargetSpec>,
	obstacles: HTMLElement[],
	params: Record<string, number>,
	neighborAura: number,
): RasterScene {
	const cell = layout.cellCss;
	const scrX = window.scrollX;
	const scrY = window.scrollY;
	const inset = params.inset ?? 0;
	const out: SceneTarget[] = [];

	const paint = (el: HTMLElement, mode: ActivityMode, own: boolean): void => {
		const spec = shapeSpecOf(el);
		applyShapeCss(el, spec);
		const rr = el.getBoundingClientRect();
		const left = rr.left + scrX;
		const top = rr.top + scrY;
		const right = rr.right + scrX;
		const bottom = rr.bottom + scrY;
		const cx = (left + right) / 2;
		const cy = (top + bottom) / 2;
		const aura = own ? 0 : neighborAura;
		const baseRx = rr.width / 2;
		const baseRy = rr.height / 2;
		const rx = baseRx + aura;
		const ry = baseRy + aura;
		const offset = inset - aura;
		const pad = Math.max(0, -offset);
		const mask =
			spec.kind === 'text'
				? maskData(textMaskOf(el, left, top, right - left, bottom - top, pad))
				: null;
		out.push({
			mode,
			own,
			spec,
			left,
			top,
			right,
			bottom,
			cx,
			cy,
			baseRx,
			baseRy,
			rx,
			ry,
			aura,
			inset,
			offset,
			pad,
			mask,
		});
	};

	for (const { el, mode } of targets) paint(el, mode, true);
	for (const el of obstacles) paint(el, 'wall', false);
	return { ...layout, targets: out, neighborAura };
}

export interface RasterMasks {
	substrate: Uint8Array;
	active: Uint8Array;
	ownSubstrate: Uint8Array;
	key: number;
}

/**
 * Paint a scene into grid masks (substrate = obstacle, active = source) and hash
 * its field inputs. Pure: runs identically on the main thread and in a worker.
 */
export function rasterizeScene(
	scene: RasterScene,
	paramValues: ReadonlyArray<number>,
): RasterMasks {
	const { w, h } = scene;
	const cell = scene.cellCss;
	const substrate = new Uint8Array(w * h);
	const active = new Uint8Array(w * h);
	const ownSubstrate = new Uint8Array(w * h);
	let key = 2166136261;
	const mix = (v: number): void => {
		key ^= v | 0;
		key = Math.imul(key, 16777619);
	};

	for (const t of scene.targets) {
		mix(t.left);
		mix(t.top);
		mix(t.right);
		mix(t.bottom);
		mix(t.mode === 'emitter' ? 0 : 1);
		mix(t.own ? 1 : 0);
		mix(kindCode(t.spec));
		mix(t.spec.sides ?? 6);
		mix(t.spec.points ?? 5);
		mix(t.aura);
		mix(Math.round(t.inset * 1000));
		if (t.mask) mix(t.mask.key);

		const x0 = Math.floor((t.left - t.pad) / cell);
		const x1 = Math.max(Math.ceil((t.right + t.pad) / cell), x0 + 1);
		const sy0 = Math.floor((t.top - t.pad) / cell);
		const sy1 = Math.max(Math.ceil((t.bottom + t.pad) / cell), sy0 + 1);
		for (let gx = x0; gx < x1; gx++) {
			for (let sy = sy0; sy < sy1; sy++) {
				const px = (gx + 0.5) * cell;
				const py = (sy + 0.5) * cell;
				if (t.mask) {
					if (!textMaskHas(t.mask, px, py, cell, t.offset)) continue;
				} else if (t.offset !== 0) {
					if (signedDistanceShape(t.spec, px, py, t.cx, t.cy, t.baseRx, t.baseRy) < t.offset) continue;
				} else if (!insideShape(t.spec, px, py, t.cx, t.cy, t.rx, t.ry)) continue;
				const gy = h - 1 - sy;
				if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
				const i = gy * w + gx;
				if (t.mode !== 'emitter') {
					substrate[i] = 1;
					if (t.own) ownSubstrate[i] = 1;
				}
				if (t.mode !== 'wall') active[i] = 1;
			}
		}
	}

	mix(w);
	mix(h);
	mix(Math.round(cell * 1000));
	mix(scene.neighborAura);
	for (const v of paramValues) mix(Math.round(v * 1000));
	return { substrate, active, ownSubstrate, key };
}
