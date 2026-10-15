import WGSL from './goo.wgsl?raw';
import type { LiveHandle, LivePatch, SeedCtx } from '@biomorphic/ca-core';

/**
 * GOO — WebGPU compute backend.
 *
 * The whole PBD fluid lives on the GPU: one compute pass per tick runs the
 * solver stages, plus GPU-side emission, culling and the metaball splat. The
 * only thing that comes back to the CPU is the density field, read back
 * asynchronously (never blocking the render loop) and throttled to every third
 * tick, so the WebGL2 engine can upload it as a `LivePatch`.
 *
 * Key differences from the first (rolled-back) attempt:
 *  - Particle positions are never read back per tick; there is no per-tick GPU
 *    synchronisation at all.
 *  - The pair passes are gathers (each particle writes only its own
 *    accumulators), so no floating-point atomics are needed.
 *  - Every compute pass shares one explicit bind group layout (bindings are
 *    per-pass subsets, all <= 8 storage buffers).
 *
 * `navigator.gpu` is checked before constructing; if the device/adapter is
 * missing or init throws, `makeFallback()` supplies the wasm solver handle.
 */

const SMOOTHING = 3;
const REST_SPACING = 1.7888544;
const SHELL = 5;
const PATCH_EVERY = 3;
const DT = 1 / 60;
const MAX_EMIT_PER_TICK = 256;

// Uniform array indices — must match goo.wgsl.
const U = {
	W: 0, H: 1, GW: 2, GH: 3, HR: 4, HR2: 5,
	DT: 6, DT2: 7, GRAV: 8, VISC: 9, STIFF: 10, TENS: 11, STICKY: 12, BLOB: 13,
	RESTD: 14, R: 15, NUMCELLS: 16, MAXPART: 17, SP: 18, OFF: 19, LGW: 20, LGH: 21,
	EMIT: 22, SPLAT: 23, TICK: 24, EMITN: 25,
} as const;

// Storage binding numbers — must match goo.wgsl.
const B = {
	P: 0, AUX: 1, GRIDHEAD: 2, GRIDNEXT: 3, EMIT: 4, LAT: 5,
	FIELD: 6, SDF: 7, DEEP: 8, COUNTER: 10, FREE: 11, UARR: 12,
} as const;

const SPLAT_SCALE = 1024;
const COUNTER_SLOTS = 10;

interface Pipe {
	pipeline: GPUComputePipeline;
	bindGroup: GPUBindGroup;
	groups: number;
}
interface Staging {
	buf: GPUBuffer;
	busy: boolean;
	ready: boolean;
}
interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

// NOTE: WebGPU globals (GPUBufferUsage, GPUMapMode) are only referenced inside
// methods, never at module scope, so importing this module in a browser without
// WebGPU cannot throw (the wasm fallback must still work there).

// Multiple goo engines can be live at once (one per group), so track them all and
// share a single GPUDevice rather than each instance requesting its own.
const gpuInstances = new Set<WebGpuGoo>();

/** Tear down every live GPU backend (e.g. when a group switches to the wasm backend). */
export function disposeActiveGpu(): void {
	for (const g of [...gpuInstances]) g.dispose();
}

let devicePromise: Promise<GPUDevice | null> | null = null;
/** One shared GPUDevice for every goo instance. */
function sharedDevice(): Promise<GPUDevice | null> {
	if (!devicePromise) {
		devicePromise = (async () => {
			if (typeof navigator === 'undefined' || !navigator.gpu) return null;
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter) return null;
			return adapter.requestDevice({
				requiredLimits: {
					maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
					maxBufferSize: adapter.limits.maxBufferSize,
				},
			});
		})().catch(() => null);
	}
	return devicePromise;
}

export class WebGpuGoo {
	readonly handle: LiveHandle;

	private ctx: SeedCtx;
	private params: Record<string, number>;
	private substrate: Uint8Array;
	private makeFallback: () => LiveHandle;
	private fallback: LiveHandle | null = null;

	private w: number;
	private h: number;
	private r: number;
	private hr: number;
	private hr2: number;
	private gw: number;
	private gh: number;
	private numCells: number;
	private sp: number;
	private off: number;
	private lgw: number;
	private lgh: number;
	private maxpart: number;
	private emitters: Float32Array;
	/** Upper bound on emitter count (all substrate active); the Emit buffer holds this many. */
	private emitCap: number;
	private fieldBytes: number;

	private device: GPUDevice | null = null;
	private bufs: Record<number, GPUBuffer> = {};
	private pipes: Record<string, Pipe> = {};
	private staging: Staging[] = [];
	private uArr = new Float32Array(32);
	private tickCount = 0;
	private prevRect: Rect | null = null;
	private ready = false;
	private disposed = false;

	constructor(ctx: SeedCtx, makeFallback: () => LiveHandle) {
		this.ctx = ctx;
		this.params = ctx.params;
		this.substrate = ctx.substrate;
		this.makeFallback = makeFallback;

		const { w, h } = ctx;
		this.w = w;
		this.h = h;
		this.r = Math.max(0.5, ctx.params.particleRadius ?? 1);
		this.hr = this.r * SMOOTHING;
		this.hr2 = this.hr * this.hr;
		this.gw = Math.ceil(w / this.hr) + 2;
		this.gh = Math.ceil(h / this.hr) + 2;
		this.numCells = this.gw * this.gh;
		this.sp = this.r * REST_SPACING;
		this.off = this.r * 1.2;
		this.lgw = Math.ceil(w / this.sp) + 2;
		this.lgh = Math.ceil(h / this.sp) + 2;
		this.maxpart = Math.max(200, Math.round(ctx.params.maxParticles ?? 3000));
		const activeMask = ctx.active ?? ctx.substrate;
		this.emitters = computeEmitters(w, h, ctx.substrate, activeMask);
		// Capacity must bound the emitter count for ANY mode combination. Emit sites
		// are the cells just outside (and in holes of) the union of every element
		// footprint, so size to that. Sizing to "all substrate active" under-counts
		// when an `emitter`-only element (a source that is NOT substrate) contributes
		// emitters; an overflow drops the whole write, the buffer stays zeroed, and
		// cs_emit reads zero entries -> spawns at world (0,0).
		const union = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) union[i] = ctx.substrate[i] || activeMask[i] ? 1 : 0;
		this.emitCap = computeEmitters(w, h, new Uint8Array(w * h), union).length / 4;
		this.fieldBytes = w * h * 4;

		this.handle = {
			tick: () => this.tick(),
			// active/emitter/wall all update in place: substrate (collision) is recomputed
			// and re-uploaded, emitters swapped — the fluid state is never restarted.
			setMasks: (substrate: Uint8Array, active: Uint8Array) =>
				this.setMasks(substrate, active),
			dispose: () => this.dispose(),
		};

		gpuInstances.add(this);
		void this.init();
	}

	dispose(): void {
		this.disposed = true;
		this.ready = false;
		this.fallback?.dispose?.();
		for (const b of Object.values(this.bufs)) {
			try {
				b.destroy();
			} catch {
				/* already gone */
			}
		}
		for (const s of this.staging) {
			try {
				s.buf.destroy();
			} catch {
				/* already gone */
			}
		}
		this.bufs = {};
		this.staging = [];
		this.pipes = {};
		gpuInstances.delete(this);
	}

	private async init(): Promise<void> {
		try {
			const device = await sharedDevice();
			if (this.disposed) return;
			if (!device) throw new Error('no WebGPU device');
			this.device = device;
			device.addEventListener('uncapturederror', (e) => {
				console.error('[goo] WebGPU error:', (e as GPUUncapturedErrorEvent).error.message);
			});
			this.createResources();
			if (this.disposed) return;
			console.log('[goo] WebGPU backend ready');
			this.ready = true;
		} catch (err) {
			console.error('[goo] WebGPU init failed — falling back to wasm:', err);
			if (!this.disposed && !this.fallback) this.fallback = this.makeFallback();
		}
	}

	/** (Re)compute and upload the static collision fields for the current substrate. */
	private uploadStatics(): void {
		const { w, h } = this;
		const sub = this.substrate;
		const free = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) free[i] = sub[i] ? 0 : 1;
		const dSub = chamfer(w, h, sub);
		const dFree = chamfer(w, h, free);
		const sdf = new Float32Array(w * h);
		for (let i = 0; i < w * h; i++) sdf[i] = sub[i] ? -dFree[i] : dSub[i];
		const cheb = chebyshev(w, h, free);
		const deep = new Uint32Array(w * h);
		for (let i = 0; i < w * h; i++) deep[i] = sub[i] && cheb[i] > SHELL ? 1 : 0;
		const q = this.device!.queue;
		q.writeBuffer(this.bufs[B.SDF], 0, sdf);
		q.writeBuffer(this.bufs[B.DEEP], 0, deep);
	}

	private createResources(): void {
		const device = this.device!;
		const STORAGE = GPUBufferUsage.STORAGE;
		const COPY_SRC = GPUBufferUsage.COPY_SRC;
		const COPY_DST = GPUBufferUsage.COPY_DST;
		// The grid is a per-cell linked list (head + next), so there is no bucket
		// capacity limit and compressed goo never has truncated neighbourhoods.

		const mk = (size: number, usage: number) =>
			device.createBuffer({ size: Math.max(4, size), usage });

		const buf: Record<number, GPUBuffer> = {};
		buf[B.P] = mk(this.maxpart * 10 * 4, STORAGE | COPY_DST);
		buf[B.AUX] = mk(this.maxpart * 12 * 4, STORAGE | COPY_DST);
		buf[B.GRIDHEAD] = mk(this.numCells * 4, STORAGE | COPY_DST);
		buf[B.GRIDNEXT] = mk(this.maxpart * 4, STORAGE | COPY_DST);
		buf[B.EMIT] = mk(Math.max(1, this.emitCap) * 16, STORAGE | COPY_DST);
		buf[B.LAT] = mk(this.lgw * this.lgh * 4, STORAGE | COPY_DST);
		buf[B.FIELD] = mk(this.fieldBytes, STORAGE | COPY_SRC | COPY_DST);
		buf[B.SDF] = mk(this.w * this.h * 4, STORAGE | COPY_DST);
		buf[B.DEEP] = mk(this.w * this.h * 4, STORAGE | COPY_DST);
		buf[B.COUNTER] = mk(COUNTER_SLOTS * 4, STORAGE | COPY_DST);
		buf[B.FREE] = mk(this.maxpart * 4, STORAGE | COPY_DST);
		buf[B.UARR] = mk(32 * 4, STORAGE | COPY_DST);
		this.bufs = buf;

		// CPU-side precompute: signed distance + deep-interior mask, then emitters.
		const { w, h } = this;
		this.uploadStatics();
		const queue = device.queue;
		if (this.emitters.length > 0) queue.writeBuffer(buf[B.EMIT], 0, this.emitters);
		queue.writeBuffer(buf[B.COUNTER], 0, new Uint32Array(COUNTER_SLOTS));

		this.staging = [0, 1, 2].map(() => ({
			buf: device.createBuffer({ size: this.fieldBytes, usage: GPUMapMode.READ | COPY_DST }),
			busy: false,
			ready: false,
		}));

		const module = device.createShaderModule({ code: WGSL });
		// Cap at the default maxComputeWorkgroupsPerDimension; the clear passes
		// below walk their range with a grid-stride loop, so this stays correct.
		const pg = (n: number) => Math.min(65535, Math.max(1, Math.ceil(n / 64)));
		const maxpg = pg(this.maxpart);
		const cellpg = pg(this.numCells);
		const latpg = pg(this.lgw * this.lgh);
		const fpg = pg(w * h);

		const defs: Array<[string, string, number[], number]> = [
			['emit_accum', 'cs_emit_accum', [B.COUNTER, B.UARR], 1],
			['clear_lattice', 'cs_clear_lattice', [B.LAT, B.UARR], latpg],
			['scatter_lattice', 'cs_scatter_lattice', [B.P, B.LAT, B.UARR], maxpg],
			['emit', 'cs_emit', [B.P, B.AUX, B.EMIT, B.LAT, B.COUNTER, B.FREE, B.UARR], 4],
			['integrate', 'cs_integrate', [B.P, B.SDF, B.UARR], maxpg],
			['clear_grid', 'cs_clear_grid', [B.GRIDHEAD, B.UARR], cellpg],
			['build_grid', 'cs_build_grid', [B.P, B.GRIDHEAD, B.GRIDNEXT, B.UARR], maxpg],
			['viscosity', 'cs_viscosity', [B.P, B.GRIDHEAD, B.GRIDNEXT, B.UARR], maxpg],
			['advance', 'cs_advance', [B.P, B.UARR], maxpg],
			['density', 'cs_density', [B.P, B.AUX, B.GRIDHEAD, B.GRIDNEXT, B.UARR], maxpg],
			['displace', 'cs_displace', [B.P, B.AUX, B.GRIDHEAD, B.GRIDNEXT, B.UARR], maxpg],
			['tension', 'cs_tension', [B.P, B.AUX, B.COUNTER, B.UARR], maxpg],
			['apply', 'cs_apply', [B.P, B.AUX, B.COUNTER, B.UARR], maxpg],
			['collide', 'cs_collide', [B.P, B.SDF, B.UARR], maxpg],
			['velocity', 'cs_velocity', [B.P, B.UARR], maxpg],
			['friction', 'cs_friction', [B.P, B.SDF, B.UARR], maxpg],
			['vx_sum', 'cs_vx_sum', [B.P, B.COUNTER, B.UARR], maxpg],
			['vx_damp', 'cs_vx_damp', [B.P, B.COUNTER, B.UARR], maxpg],
			['cull', 'cs_cull', [B.P, B.DEEP, B.COUNTER, B.FREE, B.UARR], maxpg],
			['clear_field', 'cs_clear_field', [B.FIELD, B.UARR], fpg],
			['splat', 'cs_splat', [B.P, B.FIELD, B.UARR], maxpg],
		];

		const stage = GPUShaderStage.COMPUTE;
		// Explicit per-pass layouts (not `layout: 'auto'`): an explicit layout
		// tolerates entries the shader doesn't use, whereas an auto layout only
		// contains the statically-used bindings and rejects any extra entry.
		const READ_ONLY = new Set<number>([B.EMIT, B.SDF, B.DEEP, B.UARR]);
		for (const [name, entry, binds, groups] of defs) {
			const layoutEntries: GPUBindGroupLayoutEntry[] = binds.map((b) => ({
				binding: b,
				visibility: stage,
				buffer: { type: READ_ONLY.has(b) ? 'read-only-storage' : 'storage' },
			}));
			const layout = device.createBindGroupLayout({ entries: layoutEntries });
			const pipeline = device.createComputePipeline({
				layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				compute: { module, entryPoint: entry },
			});
			const bindGroup = device.createBindGroup({
				layout,
				entries: binds.map((b) => ({ binding: b, resource: { buffer: buf[b] } })),
			});
			this.pipes[name] = { pipeline, bindGroup, groups };
		}
	}

	private writeUniforms(): void {
		const u = this.uArr;
		const p = this.params;
		u[U.W] = this.w;
		u[U.H] = this.h;
		u[U.GW] = this.gw;
		u[U.GH] = this.gh;
		u[U.HR] = this.hr;
		u[U.HR2] = this.hr2;
		u[U.DT] = DT;
		u[U.DT2] = DT * DT;
		u[U.GRAV] = p.gravity ?? 0;
		u[U.VISC] = p.viscosity ?? 0;
		u[U.STIFF] = p.stiffness ?? 0;
		u[U.TENS] = p.tension ?? 0;
		u[U.STICKY] = p.sticky ?? 0;
		u[U.BLOB] = p.blob ?? 3.8;
		u[U.RESTD] = 0.75;
		u[U.R] = this.r;
		u[U.NUMCELLS] = this.numCells;
		u[U.MAXPART] = this.maxpart;
		u[U.SP] = this.sp;
		u[U.OFF] = this.off;
		u[U.LGW] = this.lgw;
		u[U.LGH] = this.lgh;
		u[U.EMIT] = this.emitters.length > 0 ? p.emit ?? 0 : 0;
		// emitter COUNT, not float length: the buffer holds 4 floats (x,y,nx,ny) each.
		// Getting this 4x too large makes cs_emit pick stale zero entries -> spawn at
		// lattice (1,1) = world (0,0), i.e. a blob in the bottom-left corner.
		u[U.EMITN] = this.emitters.length / 4;
		u[U.SPLAT] = SPLAT_SCALE;
		u[U.TICK] = this.tickCount;
	}

	/**
	 * Swap the substrate + emit masks **in place** — no reset, particles untouched.
	 * Substates change the collision SDF, so that is recomputed and re-uploaded too;
	 * only the emitter set and the static fields change, never the fluid state.
	 * Used when an element changes between active / emitter / wall.
	 */
	setMasks(substrate: Uint8Array, active: Uint8Array): void {
		this.substrate = substrate;
		const e = computeEmitters(this.w, this.h, substrate, active);
		// never exceed the buffer capacity: an out-of-range write is dropped whole,
		// leaving zero entries that cs_emit would read as world (0,0).
		this.emitters = e.length / 4 > this.emitCap ? e.subarray(0, this.emitCap * 4) : e;
		if (!this.device) return;   // not ready yet: init() uploads from the stored masks
		this.uploadStatics();
		const q = this.device.queue;
		if (this.emitters.length > 0) q.writeBuffer(this.bufs[B.EMIT], 0, this.emitters);
		this.writeUniforms();
		q.writeBuffer(this.bufs[B.UARR], 0, this.uArr);
	}

	private dispatch(pass: GPUComputePassEncoder, name: string): void {
		const pipe = this.pipes[name];
		pass.setPipeline(pipe.pipeline);
		pass.setBindGroup(0, pipe.bindGroup);
		pass.dispatchWorkgroups(pipe.groups, 1, 1);
	}

	private tick(): LivePatch | null {
		if (this.fallback) return this.fallback.tick();
		if (!this.ready || !this.device) return null;
		this.tickCount++;
		this.writeUniforms();
		const queue = this.device.queue;
		queue.writeBuffer(this.bufs[B.UARR], 0, this.uArr);

		const enc = this.device.createCommandEncoder();
		const patchTick = this.tickCount % PATCH_EVERY === 0;
		const pass = enc.beginComputePass();
		this.dispatch(pass, 'emit_accum');
		if (this.emitCap > 0) {
			this.dispatch(pass, 'clear_lattice');
			this.dispatch(pass, 'scatter_lattice');
			this.dispatch(pass, 'emit');
		}
		this.dispatch(pass, 'integrate');
		this.dispatch(pass, 'clear_grid');
		this.dispatch(pass, 'build_grid');
		this.dispatch(pass, 'viscosity');
		this.dispatch(pass, 'advance');
		this.dispatch(pass, 'clear_grid');
		this.dispatch(pass, 'build_grid');
		this.dispatch(pass, 'density');
		this.dispatch(pass, 'displace');
		this.dispatch(pass, 'tension');
		this.dispatch(pass, 'apply');
		this.dispatch(pass, 'collide');
		this.dispatch(pass, 'velocity');
		this.dispatch(pass, 'friction');
		this.dispatch(pass, 'vx_sum');
		this.dispatch(pass, 'vx_damp');
		this.dispatch(pass, 'cull');
		let target: Staging | null = null;
		if (patchTick) {
			this.dispatch(pass, 'clear_field');
			this.dispatch(pass, 'splat');
			target = this.staging.find((s) => !s.busy) ?? null;
		}
		pass.end();
		// The copy must be encoded after the compute pass is closed.
		if (target) {
			enc.copyBufferToBuffer(this.bufs[B.FIELD], 0, target.buf, 0, this.fieldBytes);
		}
		queue.submit([enc.finish()]);
		if (target) {
			const sb = target;
			sb.busy = true;
			sb.ready = false;
			sb.buf
				.mapAsync(GPUMapMode.READ)
				.then(() => {
					sb.ready = true;
				})
				.catch(() => {
					sb.busy = false;
				});
		}
		return this.pollPatch();
	}

	private pollPatch(): LivePatch | null {
		for (const s of this.staging) {
			if (!s.ready) continue;
			let patch: LivePatch | null = null;
			try {
				patch = this.decode(new Uint32Array(s.buf.getMappedRange()));
			} finally {
				s.buf.unmap();
			}
			s.ready = false;
			s.busy = false;
			return patch;
		}
		return null;
	}

	/** Turn the raw fixed-point density field into an RGBA patch for the engine. */
	private decode(field: Uint32Array): LivePatch | null {
		const { w, h } = this;
		let x0 = w;
		let y0 = h;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) {
				if (field[row + x] !== 0) {
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
					if (y < y0) y0 = y;
					if (y > y1) y1 = y;
				}
			}
		}
		const has = x1 >= x0 && y1 >= y0;
		if (!has && !this.prevRect) return null;

		let ux0: number;
		let uy0: number;
		let ux1: number;
		let uy1: number;
		if (has && this.prevRect) {
			ux0 = Math.min(x0, this.prevRect.x);
			uy0 = Math.min(y0, this.prevRect.y);
			ux1 = Math.max(x1 + 1, this.prevRect.x + this.prevRect.w);
			uy1 = Math.max(y1 + 1, this.prevRect.y + this.prevRect.h);
		} else if (has) {
			ux0 = x0;
			uy0 = y0;
			ux1 = x1 + 1;
			uy1 = y1 + 1;
		} else {
			const p = this.prevRect!;
			ux0 = p.x;
			uy0 = p.y;
			ux1 = p.x + p.w;
			uy1 = p.y + p.h;
		}
		const uw = ux1 - ux0;
		const uh = uy1 - uy0;
		const data = new Float32Array(uw * uh * 4);
		const sub = this.substrate;
		for (let y = 0; y < uh; y++) {
			const sy = uy0 + y;
			const inY = has && sy >= y0 && sy <= y1;
			for (let x = 0; x < uw; x++) {
				const sx = ux0 + x;
				const si = sy * w + sx;
				const o = (y * uw + x) * 4;
				const isSub = sub[si] !== 0 ? 1 : 0;
				data[o] = isSub;
				data[o + 1] = isSub || !inY || sx < x0 || sx > x1 ? 0 : field[si] / SPLAT_SCALE;
			}
		}
		this.prevRect = has ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
		return { x: ux0, y: uy0, w: uw, h: uh, data };
	}
}

/** Two-pass chamfer distance transform (Euclidean approximation). */
function chamfer(w: number, h: number, sources: Uint8Array): Float32Array {
	const inf = 1e9;
	const diag = Math.SQRT2;
	const d = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++) d[i] = sources[i] ? 0 : inf;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			let v = d[i];
			if (x > 0) v = Math.min(v, d[i - 1] + 1);
			if (y > 0) v = Math.min(v, d[i - w] + 1);
			if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + diag);
			if (x + 1 < w && y > 0) v = Math.min(v, d[i - w + 1] + diag);
			d[i] = v;
		}
	}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const i = y * w + x;
			let v = d[i];
			if (x + 1 < w) v = Math.min(v, d[i + 1] + 1);
			if (y + 1 < h) v = Math.min(v, d[i + w] + 1);
			if (x + 1 < w && y + 1 < h) v = Math.min(v, d[i + w + 1] + diag);
			if (x > 0 && y + 1 < h) v = Math.min(v, d[i + w - 1] + diag);
			d[i] = v;
		}
	}
	return d;
}

/** Chebyshev distance to the nearest source cell (matches the crate's deep mask). */
function chebyshev(w: number, h: number, sources: Uint8Array): Int32Array {
	const inf = 1 << 24;
	const d = new Int32Array(w * h);
	for (let i = 0; i < w * h; i++) d[i] = sources[i] ? 0 : inf;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			let v = d[i];
			if (x > 0) v = Math.min(v, d[i - 1] + 1);
			if (y > 0) v = Math.min(v, d[i - w] + 1);
			if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1);
			if (x + 1 < w && y > 0) v = Math.min(v, d[i - w + 1] + 1);
			d[i] = v;
		}
	}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const i = y * w + x;
			let v = d[i];
			if (x + 1 < w) v = Math.min(v, d[i + 1] + 1);
			if (y + 1 < h) v = Math.min(v, d[i + w] + 1);
			if (x + 1 < w && y + 1 < h) v = Math.min(v, d[i + w + 1] + 1);
			if (x > 0 && y + 1 < h) v = Math.min(v, d[i + w - 1] + 1);
			d[i] = v;
		}
	}
	return d;
}

/** Free cells touching an ACTIVE substrate cell, with an outward unit normal (x, y, nx, ny). */
function computeEmitters(w: number, h: number, substrate: Uint8Array, active: Uint8Array = substrate): Float32Array {
	const out: number[] = [];
	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			if (substrate[gy * w + gx] !== 0) continue;
			// Skip a source's own cells: for an `emitter` element (not substrate) this
			// keeps emitters just outside its rim rather than inside it. No-op when
			// active ⊆ substrate (active/wall modes).
			if (active[gy * w + gx] !== 0) continue;
			const ex = gx + 0.5;
			const ey = gy + 0.5;
			let nx = 0;
			let ny = 0;
			let touching = false;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const sx = gx + dx;
					const sy = gy + dy;
					if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
					const j = sy * w + sx;
					if (substrate[j] !== 0 || active[j] !== 0) {
						nx += ex - (sx + 0.5);
						ny += ey - (sy + 0.5);
					}
					if (active[j] !== 0) touching = true;   // only active walls emit
				}
			}
			if (!touching) continue;
			const len = Math.max(Math.hypot(nx, ny), 1e-4);
			out.push(ex, ey, nx / len, ny / len);
		}
	}
	return new Float32Array(out);
}
