import { paramsFrom } from './engine-core';
import type { BioEngine, EngineOptions } from './engine-api';
import type { WorkerRequest, WorkerResponse } from './offscreen-protocol';
import { collectScene, layoutFor } from './scene';
import type { GridLayout, RasterScene } from './scene';
import type { ActivityMode, Material, TargetSpec, UpsampleMode } from './types';

export interface OffscreenEngineOptions extends EngineOptions {
	/** Worker from the runtime's pool (or the sticky live-tissue worker). */
	worker: Worker;
	/** Group id (key inside the worker). */
	id: string;
	/** Seed for the worker-side deterministic RNG. */
	seed: number;
	/** Namespace for shared live tissue (all tree groups in a worker share one map). */
	bioId: string;
	/** This group's token within the shared tissue map. */
	token: number;
	/** Whether live groups avoid each other's tissue. */
	collideNeighbors: boolean;
}

/** True when this browser can hand a canvas's rendering to a worker. */
export function canUseOffscreen(): boolean {
	return (
		typeof OffscreenCanvas !== 'undefined' &&
		typeof Worker !== 'undefined' &&
		typeof HTMLCanvasElement !== 'undefined' &&
		'transferControlToOffscreen' in HTMLCanvasElement.prototype
	);
}

/**
 * Main-thread facade for an engine running in a worker on an OffscreenCanvas.
 *
 * The DOM work (measuring rects, syncing shape CSS, sampling text glyphs into a
 * mask) stays here; the expensive rasterization, distance field, seeding, sim
 * and render run in the worker, so a reset or a fine grid can't stall the page.
 * State the runtime needs synchronously (`frozen`, `settled`) is mirrored here
 * from worker status messages.
 */
export class OffscreenEngine implements BioEngine {
	readonly canvas: HTMLCanvasElement;

	private readonly worker: Worker;
	private readonly id: string;
	private readonly targets: () => TargetSpec[];
	private readonly obstacles: () => HTMLElement[];
	private readonly onMessage: (e: MessageEvent) => void;

	private _material: Material;
	private _params: Record<string, number>;
	private _speed: number;
	private _playing = true;
	private _instant = false;
	private _upsample: UpsampleMode = 'linear';
	private _cellSize = 4;
	private _settled = false;
	private _manual = false;
	private _lastW = 0;
	private _lastH = 0;
	private maxTextureSize = 0;
	private readonly bioId: string;
	private readonly token: number;
	private readonly collideNeighbors: boolean;
	private tx = 0;
	private ty = 0;
	/** Messages held until the worker has loaded and the canvas is transferred. */
	private readonly pending: WorkerRequest[] = [];
	private created = false;
	private creating = false;
	private disposed = false;
	private createLayout: GridLayout;
	private readonly seed: number;

	seedChance = 0.5;
	maxCells: number;
	neighborAura: number;

	constructor(canvas: HTMLCanvasElement, material: Material, opts: OffscreenEngineOptions) {
		this.canvas = canvas;
		this._material = material;
		this._params = paramsFrom(material);
		this._speed = opts.speed ?? material.speed ?? 3;
		this.worker = opts.worker;
		this.id = opts.id;
		this.seed = opts.seed;
		this.bioId = opts.bioId;
		this.token = opts.token;
		this.collideNeighbors = opts.collideNeighbors;
		this.maxCells = opts.maxCells ?? 4_000_000;
		this.neighborAura = opts.neighborAura ?? 0;
		this.targets =
			opts.targets ??
			(() =>
				Array.from(document.querySelectorAll<HTMLElement>('.sub')).map((el) => ({
					el,
					mode: 'active' as ActivityMode,
				})));
		this.obstacles = opts.obstacles ?? (() => []);

		this.onMessage = (e: MessageEvent): void => {
			const m = e.data as WorkerResponse;
			if (!m || m.id !== this.id) return;
			if (m.t === 'status') this._settled = m.settled;
			else if (m.t === 'ready') {
				if (m.maxTextureSize) this.maxTextureSize = m.maxTextureSize;
				this.createLayout = this.fit();
				this._lastW = this.createLayout.w;
				this._lastH = this.createLayout.h;
				this.create();
			} else if (m.t === 'error') console.error('[bio worker]', m.message);
		};
		this.worker.addEventListener('message', this.onMessage);

		this.createLayout = this.fit();
		this._lastW = this.createLayout.w;
		this._lastH = this.createLayout.h;
		// Transferring a canvas before the worker module has evaluated leaves the
		// placeholder without a bitmap in Chrome, so wait for a ready reply.
		this.worker.postMessage({ t: 'hello', id: this.id } satisfies WorkerRequest);
	}

	/** The worker is up: transfer this canvas and flush anything queued before it. */
	private create(): void {
		if (this.created || this.creating || this.disposed) return;
		this.creating = true;
		// A canvas transferred before its first paint can lose its bitmap link in
		// Chrome (the worker renders, the placeholder stays blank). Let the empty
		// canvas paint once, then hand it over.
		const raf =
			typeof requestAnimationFrame !== 'undefined'
				? requestAnimationFrame
				: (cb: FrameRequestCallback): number => setTimeout(() => cb(performance.now()), 0) as unknown as number;
		raf(() => raf(() => this.transfer()));
	}

	private transfer(): void {
		if (this.created || this.disposed) return;
		this.created = true;
		let off: OffscreenCanvas;
		try {
			off = this.canvas.transferControlToOffscreen();
		} catch (err) {
			console.error('[bio worker] canvas transfer failed', err);
			return;
		}
		const needsReset = this.pending.some((m) => m.t === 'reset' || m.t === 'refresh' || m.t === 'fit');
		for (let i = this.pending.length - 1; i >= 0; i--) {
			const t = this.pending[i].t;
			if (t === 'reset' || t === 'refresh' || t === 'fit') this.pending.splice(i, 1);
		}
		this.worker.postMessage(
			{
				t: 'create',
				id: this.id,
				material: this._material.id,
				canvas: off,
				grid: this.createLayout,
				params: { ...this._params },
				speed: this._speed,
				instant: this._instant,
				upsample: this._upsample,
				neighborAura: this.neighborAura,
				seed: this.seed,
				bioId: this.bioId,
				token: this.token,
				collideNeighbors: this.collideNeighbors,
			} satisfies WorkerRequest,
			{ transfer: [off] },
		);
		for (const msg of this.pending) this.worker.postMessage(msg);
		this.pending.length = 0;
		if (needsReset) this.reset();
	}

	get material(): Material {
		return this._material;
	}

	get params(): Record<string, number> {
		return this._params;
	}

	get speed(): number {
		return this._speed;
	}
	set speed(v: number) {
		if (v === this._speed) return;
		this._speed = v;
		this.post({ t: 'speed', id: this.id, speed: v });
	}

	get playing(): boolean {
		return this._playing;
	}
	set playing(v: boolean) {
		if (v === this._playing) return;
		this._playing = v;
		this.post({ t: 'playing', id: this.id, playing: v });
	}

	get instant(): boolean {
		return this._instant;
	}
	set instant(v: boolean) {
		if (v === this._instant) return;
		this._instant = v;
		this.post({ t: 'instant', id: this.id, instant: v });
	}

	get cellSize(): number {
		return this._cellSize;
	}
	set cellSize(v: number) {
		this._cellSize = v;
	}

	get upsampleMode(): UpsampleMode {
		return this._upsample;
	}

	get settled(): boolean {
		return this._settled;
	}

	get frozen(): boolean {
		return this._manual || this._settled;
	}

	get manualFrozen(): boolean {
		return this._manual;
	}

	private post(msg: WorkerRequest, transfer?: Transferable[]): void {
		if (this.disposed) return;
		if (!this.created) {
			this.pending.push(msg);
			return;
		}
		if (transfer) this.worker.postMessage(msg, { transfer });
		else this.worker.postMessage(msg);
	}

	/** Set the canvas CSS size (the worker owns the backing store). */
	private fit(): GridLayout {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const cssW = document.documentElement.clientWidth || window.innerWidth;
		const cssH = Math.max(window.innerHeight, document.documentElement.scrollHeight);
		this.canvas.style.position = 'absolute';
		this.canvas.style.top = '0px';
		this.canvas.style.left = '0px';
		this.canvas.style.width = `${cssW}px`;
		this.canvas.style.height = `${cssH}px`;
		this.createLayout = layoutFor(cssW, cssH, dpr, this._cellSize, this.maxCells, this.maxTextureSize);
		return this.createLayout;
	}

	private scene(layout: GridLayout): RasterScene {
		if (typeof this._params.neighborAura === 'number') {
			this.neighborAura = this._params.neighborAura;
		}
		try {
			return collectScene(layout, this.targets(), this.obstacles(), this._params, this.neighborAura);
		} catch (err) {
			console.error('[bio] scene collection failed', err);
			return { ...layout, targets: [], neighborAura: this.neighborAura };
		}
	}

	reset(): void {
		this.clearTransform();
		const layout = this.fit();
		this._lastW = layout.w;
		this._lastH = layout.h;
		this._settled = false;
		this.post({
			t: 'reset',
			id: this.id,
			grid: layout,
			scene: this.scene(layout),
			params: { ...this._params },
			speed: this._speed,
			instant: this._instant,
			upsample: this._upsample,
			seedChance: this.seedChance,
			neighborAura: this.neighborAura,
		});
	}

	resize(): void {
		this.reset();
	}

	refit(): boolean {
		const layout = this.fit();
		const changed = layout.w !== this._lastW || layout.h !== this._lastH;
		if (changed) {
			this.reset();
			return true;
		}
		this.post({ t: 'fit', id: this.id, grid: layout });
		return false;
	}

	refreshActivity(): void {
		const layout = this.fit();
		if (layout.w !== this._lastW || layout.h !== this._lastH) {
			this.reset();
			return;
		}
		this.post({
			t: 'refresh',
			id: this.id,
			grid: layout,
			scene: this.scene(layout),
			params: { ...this._params },
		});
	}

	wake(): void {
		this._settled = false;
		this.post({
			t: 'wake',
			id: this.id,
			params: { ...this._params },
			speed: this._speed,
			instant: this._instant,
		});
	}

	freeze(): void {
		this._manual = true;
		this.post({ t: 'freeze', id: this.id });
	}

	unfreeze(): void {
		this._manual = false;
		if (this.tx !== 0 || this.ty !== 0) {
			this.reset();
			return;
		}
		this._settled = false;
		this.post({
			t: 'unfreeze',
			id: this.id,
			params: { ...this._params },
			instant: this._instant,
		});
	}

	translateBy(dx: number, dy: number): void {
		this.tx += dx;
		this.ty += dy;
		this.canvas.style.transform = `translate(${this.tx}px, ${this.ty}px)`;
	}

	private clearTransform(): void {
		if (this.tx === 0 && this.ty === 0 && !this.canvas.style.transform) return;
		this.tx = 0;
		this.ty = 0;
		this.canvas.style.transform = '';
	}

	stepOnce(): void {
		this.post({ t: 'step', id: this.id, params: { ...this._params } });
	}

	settleNow(): void {
		this.post({
			t: 'settle',
			id: this.id,
			params: { ...this._params },
			instant: this._instant,
		});
	}

	setUpsample(mode: UpsampleMode): void {
		if (mode === this._upsample) return;
		this._upsample = mode;
		this.post({ t: 'upsample', id: this.id, mode });
	}

	setMaterial(material: Material): void {
		this._material = material;
		this._params = paramsFrom(material);
		this._speed = material.speed ?? 3;
		this.post({
			t: 'setMaterial',
			id: this.id,
			material: material.id,
			bioId: this.bioId,
			token: this.token,
			collideNeighbors: this.collideNeighbors,
		});
		this.reset();
	}

	dispose(): void {
		if (this.disposed) return;
		if (this.created) this.worker.postMessage({ t: 'dispose', id: this.id } satisfies WorkerRequest);
		this.disposed = true;
		this.pending.length = 0;
		this.worker.removeEventListener('message', this.onMessage);
	}
}
