import { BLIT_FS, BUILTIN_UNIFORMS, declaredUniforms, VERT } from './glsl';
import { rasterizeScene } from './scene';
import type { GridLayout, RasterScene } from './scene';
import type {
	FieldData,
	LiveHandle,
	LivePatch,
	Material,
	Occupancy,
	SeedCtx,
	UpsampleMode,
} from './types';

/** `UpsampleMode` -> the blit shader's `u_filter` value. */
const UPSAMPLE: Record<UpsampleMode, number> = { linear: 0, nearest: 1, cubic: 2, lanczos: 3 };

export type Params = Record<string, number>;

export interface CoreOptions {
	grid: GridLayout;
	params?: Params;
	speed?: number;
	instant?: boolean;
	upsample?: UpsampleMode;
	rand?: () => number;
	neighborAura?: number;
	occupancy?: Occupancy;
	token?: number;
	/** Called whenever the settled state changes (worker -> main status mirror). */
	onStatus?: (settled: boolean) => void;
	raf?: (cb: FrameRequestCallback) => number;
	cancelRaf?: (id: number) => void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type)!;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error(`Shader compile error: ${log}\n${src}`);
	}
	return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
	const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
	const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
	const prog = gl.createProgram()!;
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
	}
	return prog;
}

const defaultRaf = (cb: FrameRequestCallback): number =>
	typeof requestAnimationFrame !== 'undefined'
		? requestAnimationFrame(cb)
		: (setTimeout(() => cb(performance.now()), 16) as unknown as number);

const defaultCancelRaf = (id: number): void => {
	if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(id);
	else clearTimeout(id);
};

/**
 * DOM-free simulation/render core. The `OffscreenEngine` facade measures the DOM
 * into a scene and posts it to a worker, which runs this class; the sim, field
 * build and GL work therefore never block the page.
 */
export class GLEngine {
	readonly canvas: HTMLCanvasElement | OffscreenCanvas;
	readonly gl: WebGL2RenderingContext;

	material: Material;
	params: Params;
	speed: number;
	seedChance = 0.5;
	playing = true;
	instant = false;
	neighborAura = 0;
	occupancy?: Occupancy;
	token = 0;
	rand: () => number;
	/** Current grid size (cells). */
	w = 0;
	h = 0;
	/** CSS px per cell. */
	cellCss = 4;

	private hold = false;
	private resolveFilter = 0;
	private upsample = 0;
	private texA!: WebGLTexture;
	private texB!: WebGLTexture;
	private fboA!: WebGLFramebuffer;
	private fboB!: WebGLFramebuffer;
	private resTex!: WebGLTexture;
	private resFbo!: WebGLFramebuffer;
	private texField: WebGLTexture | null = null;
	private fieldKey = 0;
	private simProg!: WebGLProgram;
	private resProg!: WebGLProgram;
	private blitProg!: WebGLProgram;
	private vao!: WebGLVertexArrayObject;
	private readonly locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
	private raf = 0;
	private frame = 0;
	private clock = 0;
	private settleAt = Infinity;
	private liveIdle = 0;
	private liveSettled = false;
	private liveFinite = false;
	private live: LiveHandle | null = null;
	private dirty = true;
	private lastSettled = false;
	private readonly onStatus?: (settled: boolean) => void;
	private readonly rafFn: (cb: FrameRequestCallback) => number;
	private readonly cancelRafFn: (id: number) => void;

	constructor(
		canvas: HTMLCanvasElement | OffscreenCanvas,
		material: Material,
		opts: CoreOptions,
	) {
		this.canvas = canvas;
		const gl = canvas.getContext('webgl2', {
			alpha: true,
			premultipliedAlpha: false,
			antialias: false,
			preserveDrawingBuffer: false,
		}) as WebGL2RenderingContext | null;
		if (!gl) throw new Error('WebGL2 is not available');
		this.gl = gl;
		if (!gl.getExtension('EXT_color_buffer_float')) {
			console.warn('EXT_color_buffer_float unavailable; float render targets may fail');
		}
		gl.getExtension('OES_texture_float_linear');

		this.material = material;
		this.params = paramsFrom(material);
		if (opts.params) Object.assign(this.params, opts.params);
		this.speed = opts.speed ?? material.speed ?? 3;
		this.instant = opts.instant ?? false;
		this.neighborAura = opts.neighborAura ?? 0;
		this.occupancy = opts.occupancy;
		this.token = opts.token ?? 0;
		this.rand = opts.rand ?? Math.random;
		this.onStatus = opts.onStatus;
		this.rafFn = opts.raf ?? defaultRaf;
		this.cancelRafFn = opts.cancelRaf ?? defaultCancelRaf;

		this.vao = this.makeQuad();
		this.buildPrograms();
		this.setGrid(opts.grid);
		if (opts.upsample) this.setUpsample(opts.upsample);
		this.loop();
	}

	get upsampleMode(): UpsampleMode {
		for (const [mode, n] of Object.entries(UPSAMPLE)) {
			if (n === this.upsample) return mode as UpsampleMode;
		}
		return 'linear';
	}

	setUpsample(mode: UpsampleMode): void {
		const n = UPSAMPLE[mode] ?? 0;
		if (n === this.upsample && this.resTex) return;
		this.upsample = n;
		this.resolveFilter = n === 0 ? this.gl.LINEAR : this.gl.NEAREST;
		if (this.resTex) {
			const gl = this.gl;
			gl.bindTexture(gl.TEXTURE_2D, this.resTex);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.resolveFilter);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.resolveFilter);
		}
		this.dirty = true;
	}

	/**
	 * Adopt a new grid/canvas size. Recreates the state textures only when the grid
	 * dimensions changed (a pure backing-store change just re-scales the blit).
	 */
	setGrid(grid: GridLayout): boolean {
		const resized = this.canvas.width !== grid.bw || this.canvas.height !== grid.bh;
		if (this.canvas.width !== grid.bw) this.canvas.width = grid.bw;
		if (this.canvas.height !== grid.bh) this.canvas.height = grid.bh;
		this.cellCss = grid.cellCss;
		const changed = !this.texA || grid.w !== this.w || grid.h !== this.h;
		this.w = grid.w;
		this.h = grid.h;
		if (changed) {
			this.resolveFilter = this.upsample === 0 ? this.gl.LINEAR : this.gl.NEAREST;
			this.createTargets();
		}
		if (changed || resized) this.dirty = true;
		return changed;
	}

	setMaterial(material: Material): void {
		this.clearOccupancy();
		this.material = material;
		this.params = paramsFrom(material);
		this.fieldKey = 0;
		this.speed = material.speed ?? 3;
		this.buildPrograms();
		this.dirty = true;
	}

	reset(scene: RasterScene): void {
		const gl = this.gl;
		this.setGrid(scene);
		this.lastSettled = false;
		this.onStatus?.(false);
		this.frame = 0;
		this.clock = 0;
		this.hold = false;
		this.liveIdle = 0;
		this.liveSettled = false;
		this.liveFinite = !!this.material.live?.finite;
		this.settleAt = this.material.settle ? this.material.settle(this.params) : Infinity;
		if (typeof this.params.seedChance === 'number') this.seedChance = this.params.seedChance;
		if (typeof this.params.neighborAura === 'number') this.neighborAura = this.params.neighborAura;
		const { w, h } = this;
		if (this.occupancy && this.token && this.material.usesOccupancy) {
			const o = this.occupancy;
			if (o.w !== w || o.h !== h || o.owner.length !== w * h) {
				o.w = w;
				o.h = h;
				o.owner = new Int32Array(w * h);
			}
		}
		this.clearOccupancy();

		const { substrate, active, ownSubstrate, key } = rasterizeScene(
			scene,
			this.material.params.map((p) => this.params[p.key]),
		);

		const ctx: SeedCtx = {
			w,
			h,
			substrate,
			active,
			ownSubstrate,
			seedChance: this.seedChance,
			params: this.params,
			rand: this.rand,
			occupancy: this.occupancy,
			token: this.token,
			neighborAura: this.cellCss > 0 ? Math.round(this.neighborAura / this.cellCss) : 0,
		};
		this.live?.dispose?.();
		const data = this.material.live
			? (() => {
					const r = this.material.live!.start(ctx);
					this.live = r.handle;
					return r.initial;
				})()
			: ((this.live = null), this.material.seed!(ctx));

		gl.bindTexture(gl.TEXTURE_2D, this.texA);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);

		if (this.material.field) {
			if (!(this.texField && key === this.fieldKey)) {
				this.uploadField(this.material.field(ctx));
				this.fieldKey = key;
			}
		} else {
			this.uploadField(null);
			this.fieldKey = 0;
		}

		if (this.instant) this.settleNow();
		this.dirty = true;
		this.publishStatus();
	}

	refreshActivity(scene: RasterScene): void {
		if (!this.live?.setMasks) {
			this.reset(scene);
			return;
		}
		this.setGrid(scene);
		const { substrate, active } = rasterizeScene(
			scene,
			this.material.params.map((p) => this.params[p.key]),
		);
		this.live.setMasks(substrate, active);
		this.dirty = true;
	}

	get settled(): boolean {
		return this.material.live ? this.liveSettled : this.frame >= this.settleAt;
	}

	get frozen(): boolean {
		return this.hold || this.settled;
	}

	get manualFrozen(): boolean {
		return this.hold;
	}

	freeze(): void {
		this.hold = true;
	}

	unfreeze(): void {
		this.hold = false;
		this.wake();
	}

	stepOnce(): void {
		if (this.hold) return;
		if (this.live) {
			if (this.liveSettled) return;
			const patch = this.live.tick();
			if (patch) {
				this.uploadPatch(patch);
				this.liveIdle = 0;
			} else if (this.liveFinite && ++this.liveIdle >= 3) {
				this.liveSettled = true;
			}
		} else if (this.frame < this.settleAt) {
			this.step();
		}
		this.dirty = true;
		this.publishStatus();
	}

	wake(): void {
		this.hold = false;
		this.frame = 0;
		this.liveIdle = 0;
		this.liveSettled = false;
		if (this.instant) this.settleNow();
		this.dirty = true;
		this.publishStatus();
	}

	settleNow(): void {
		if (this.hold) return;
		if (this.live) {
			if (!this.liveFinite || this.liveSettled) return;
			let idle = 0;
			for (let i = 0; i < 1_000_000 && idle < 3; i++) {
				const patch = this.live.tick();
				if (patch) {
					this.uploadPatch(patch);
					idle = 0;
				} else {
					idle++;
				}
			}
			this.liveIdle = 0;
			this.liveSettled = true;
		} else if (Number.isFinite(this.settleAt)) {
			for (let i = 0; i < this.settleAt && this.frame < this.settleAt; i++) this.step();
		}
		this.dirty = true;
		this.publishStatus();
	}

	dispose(): void {
		this.cancelRafFn(this.raf);
		this.live?.dispose?.();
		this.live = null;
		this.clearOccupancy();
	}

	private animated(): boolean {
		return this.material.animated?.(this.params) ?? false;
	}

	private publishStatus(): void {
		const settled = this.settled;
		if (settled !== this.lastSettled) {
			this.lastSettled = settled;
			this.onStatus?.(settled);
		}
	}

	private clearOccupancy(): void {
		if (!this.material.usesOccupancy || !this.occupancy || !this.token) return;
		const owner = this.occupancy.owner;
		for (let i = 0; i < owner.length; i++) if (owner[i] === this.token) owner[i] = 0;
	}

	private loop = (): void => {
		this.raf = this.rafFn(this.loop);
		if (this.live) {
			if (this.playing && !this.hold && !this.liveSettled) {
				let any = false;
				for (let i = 0; i < this.speed; i++) {
					const patch = this.live.tick();
					if (patch) {
						this.uploadPatch(patch);
						any = true;
					}
				}
				if (any) this.liveIdle = 0;
				else if (this.liveFinite && ++this.liveIdle >= 3) this.liveSettled = true;
				this.dirty = true;
			}
		} else if (this.playing && !this.hold) {
			let stepped = false;
			for (let i = 0; i < this.speed && this.frame < this.settleAt; i++) {
				this.step();
				stepped = true;
			}
			if (stepped) this.dirty = true;
		}
		const settled = this.settled;
		if (settled !== this.lastSettled) {
			this.lastSettled = settled;
			this.onStatus?.(settled);
			this.dirty = true;
		}
		// A settled static field, a paused sim, or a manually held field doesn't
		// change, so don't re-resolve + re-blit it every frame (mobile GPUs care).
		const advancing = !settled && this.playing && !this.hold;
		if (this.dirty || advancing || this.animated()) {
			this.render();
			this.dirty = false;
		}
	};

	private makeQuad(): WebGLVertexArrayObject {
		const gl = this.gl;
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const buf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		return vao;
	}

	private buildPrograms(): void {
		const gl = this.gl;
		if (this.simProg) gl.deleteProgram(this.simProg);
		if (this.resProg) gl.deleteProgram(this.resProg);
		this.simProg = link(gl, VERT, this.material.sim);
		this.resProg = link(gl, VERT, this.material.resolve);
		if (!this.blitProg) this.blitProg = link(gl, VERT, BLIT_FS);
		this.checkUniformBindings();
	}

	private checkUniformBindings(): void {
		const keys = new Set(this.material.params.map((p) => p.key));
		const shaders: Array<[string, string]> = [
			['sim', this.material.sim],
			['resolve', this.material.resolve],
		];
		for (const [which, src] of shaders) {
			for (const u of declaredUniforms(src)) {
				if (BUILTIN_UNIFORMS.has(u) || !u.startsWith('u_')) continue;
				if (!keys.has(u.slice(2))) {
					console.warn(`[ca] ${this.material.id}.${which}: uniform "${u}" has no matching param — it will stay 0`);
				}
			}
		}
	}

	private createTargets(): void {
		const gl = this.gl;
		const { w, h } = this;
		for (const t of [this.texA, this.texB, this.resTex]) if (t) gl.deleteTexture(t);
		for (const f of [this.fboA, this.fboB, this.resFbo]) if (f) gl.deleteFramebuffer(f);
		if (this.texField) {
			gl.deleteTexture(this.texField);
			this.texField = null;
		}

		this.texA = this.makeStateTexture(w, h);
		this.texB = this.makeStateTexture(w, h);
		this.fboA = this.makeFbo(this.texA);
		this.fboB = this.makeFbo(this.texB);

		const rt = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, rt);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.resolveFilter || gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.resolveFilter || gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
		this.resTex = rt;
		this.resFbo = this.makeFbo(rt);
	}

	private makeStateTexture(w: number, h: number): WebGLTexture {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
		return tex;
	}

	private makeFbo(tex: WebGLTexture): WebGLFramebuffer {
		const gl = this.gl;
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		return fbo;
	}

	private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
		let m = this.locs.get(prog);
		if (!m) {
			m = new Map();
			this.locs.set(prog, m);
		}
		if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
		return m.get(name)!;
	}

	private step(): void {
		this.frame++;
		this.runSim(this.fboB, this.texA, this.texField);
		const t = this.texA;
		this.texA = this.texB;
		this.texB = t;
		const f = this.fboA;
		this.fboA = this.fboB;
		this.fboB = f;
	}

	private runSim(writeFbo: WebGLFramebuffer, readTex: WebGLTexture, fieldTex: WebGLTexture | null): void {
		const gl = this.gl;
		const { w, h } = this;
		gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
		gl.viewport(0, 0, w, h);
		gl.disable(gl.BLEND);
		gl.useProgram(this.simProg);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, readTex);
		gl.uniform1i(this.loc(this.simProg, 'u_state'), 0);
		gl.uniform1f(this.loc(this.simProg, 'u_frame'), this.frame);
		if (fieldTex) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, fieldTex);
			gl.uniform1i(this.loc(this.simProg, 'u_field'), 1);
		}
		for (const p of this.material.params) {
			gl.uniform1f(this.loc(this.simProg, `u_${p.key}`), this.params[p.key]);
		}
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	private render(): void {
		const gl = this.gl;
		const { w, h } = this;
		this.clock++;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.resFbo);
		gl.viewport(0, 0, w, h);
		gl.disable(gl.BLEND);
		gl.useProgram(this.resProg);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texA);
		gl.uniform1i(this.loc(this.resProg, 'u_state'), 0);
		gl.uniform1f(this.loc(this.resProg, 'u_frame'), this.clock);
		for (const p of this.material.params) {
			gl.uniform1f(this.loc(this.resProg, `u_${p.key}`), this.params[p.key]);
		}
		if (this.texField) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.texField);
			gl.uniform1i(this.loc(this.resProg, 'u_field'), 1);
		}
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(this.blitProg);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.resTex);
		gl.uniform1i(this.loc(this.blitProg, 'u_tex'), 0);
		gl.uniform1i(this.loc(this.blitProg, 'u_filter'), this.upsample);
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	private uploadPatch(p: LivePatch): void {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.texA);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, p.x, p.y, p.w, p.h, gl.RGBA, gl.FLOAT, p.data);
	}

	private uploadField(f: Float32Array | FieldData | null): void {
		const gl = this.gl;
		const { w, h } = this;
		if (!f) {
			if (this.texField) {
				gl.deleteTexture(this.texField);
				this.texField = null;
			}
			return;
		}
		const data = f instanceof Float32Array ? f : f.data;
		const fw = f instanceof Float32Array ? w : f.w;
		const fh = f instanceof Float32Array ? h : f.h;
		if (!this.texField) {
			const tex = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			this.texField = tex;
		}
		gl.bindTexture(gl.TEXTURE_2D, this.texField);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, fw, fh, 0, gl.RG, gl.FLOAT, data);
	}

	/** Exposed for the main wrapper's live setMasks shortcut. */
	get liveHandle(): LiveHandle | null {
		return this.live;
	}
}

export function paramsFrom(material: Material): Params {
	const p: Params = {};
	for (const def of material.params) p[def.key] = def.value;
	return p;
}
