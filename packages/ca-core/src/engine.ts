import { BLIT_FS, BUILTIN_UNIFORMS, declaredUniforms, VERT } from './glsl';
import { applyShapeCss, insideShape, shapeSpecOf } from './shapes';
import type { ActivityMode, LiveHandle, LivePatch, Material, Occupancy, SeedCtx, TargetSpec } from './types';

type Params = Record<string, number>;

export interface EngineOptions {
	/** Elements to rasterize on each reset, with their activity mode. Defaults to every `.sub` (all active). */
	targets?: () => TargetSpec[];
	/**
	 * Elements owned by OTHER groups: rasterized as inert obstacles only (never
	 * sources), so an independent group's growth stops at a neighbour instead of
	 * overlapping it. Sampled at reset; a neighbour moving never rebuilds this
	 * group, so the obstacle set is a snapshot until this group next resets.
	 */
	obstacles?: () => HTMLElement[];
	/**
	 * Cross-group separation, in CSS px. When a *foreign* group's element (or live
	 * tissue) is used as a collider here, it is grown by this much, so this group
	 * keeps a gap from its neighbours instead of touching them (crown shyness).
	 * Never applied to the group's *own* elements, so it doesn't change this group's
	 * own behaviour. 0 (default) = collide at the exact boundary.
	 */
	neighborAura?: number;
	/**
	 * Shared live-tissue map. The engine sizes it to its own grid on the first
	 * resize and relays it (with `token`) to `live.start`, so independent live
	 * sims can avoid each other's tissue. Absent => no cross-group sharing.
	 */
	occupancy?: Occupancy;
	/** This group's token within `occupancy` (`0` = none). */
	token?: number;
	/** Deterministic RNG handed to seeding; defaults to Math.random. */
	rand?: () => number;
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

export class CAEngine {
	readonly gl: WebGL2RenderingContext;
	readonly canvas: HTMLCanvasElement;

	material: Material;
	params: Params;
	speed: number;
	seedChance = 0.5;
	cellSize = 4;
	playing = true;
	subSelector = '.sub';
	/** Elements rasterized on reset (with activity mode); swappable by the runtime. */
	targets: () => TargetSpec[];
	/** Elements from other groups, rasterized as inert obstacles only. */
	obstacles: () => HTMLElement[];
	/** Cross-group separation in CSS px, applied to foreign colliders only. */
	neighborAura = 0;
	/** Shared live-tissue map (owned by the runtime), or undefined when standalone. */
	occupancy?: Occupancy;
	/** This group's token within `occupancy`. */
	token = 0;
	/** Deterministic seeding RNG (seeded per group so rebuilds are reproducible). */
	rand: () => number;

	private dpr = 1;
	private cellCss = 4;
	private resolveFilter = 0;

	private w = 0;
	private h = 0;
	private texA!: WebGLTexture;
	private texB!: WebGLTexture;
	private fboA!: WebGLFramebuffer;
	private fboB!: WebGLFramebuffer;
	private resTex!: WebGLTexture;
	private resFbo!: WebGLFramebuffer;
	private texField: WebGLTexture | null = null;
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
	/** CSS-px translation applied to the canvas for rigid moves of a settled field. */
	private tx = 0;
	private ty = 0;

	constructor(canvas: HTMLCanvasElement, material: Material, opts: EngineOptions = {}) {
		this.canvas = canvas;
		const gl = canvas.getContext('webgl2', {
			alpha: true,
			premultipliedAlpha: false,
			antialias: false,
			preserveDrawingBuffer: false,
		});
		if (!gl) throw new Error('WebGL2 is not available');
		this.gl = gl;
		if (!gl.getExtension('EXT_color_buffer_float')) {
			console.warn('EXT_color_buffer_float unavailable; float render targets may fail');
		}
		gl.getExtension('OES_texture_float_linear');

		this.material = material;
		this.params = paramsFrom(material);
		this.speed = material.speed ?? 3;
		this.targets =
			opts.targets ??
			(() =>
				Array.from(document.querySelectorAll<HTMLElement>(this.subSelector)).map((el) => ({
					el,
					mode: 'active' as ActivityMode,
				})));
		this.obstacles = opts.obstacles ?? (() => []);
		this.neighborAura = opts.neighborAura ?? 0;
		this.occupancy = opts.occupancy;
		this.token = opts.token ?? 0;
		this.rand = opts.rand ?? Math.random;

		this.vao = this.makeQuad();
		this.buildPrograms();
		this.resize();
		this.loop();
	}

	setMaterial(material: Material): void {
		this.clearOccupancy();   // free old tissue before the material (and its flag) change
		this.material = material;
		this.params = paramsFrom(material);
		this.speed = material.speed ?? 3;
		this.buildPrograms();
		this.reset();
	}

	resize(): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		// cover the whole document so growth stays attached to elements on scroll
		const cssW = document.documentElement.clientWidth || window.innerWidth;
		const cssH = Math.max(window.innerHeight, document.documentElement.scrollHeight);
		this.canvas.style.position = 'absolute';
		this.canvas.style.top = '0px';
		this.canvas.style.left = '0px';
		this.canvas.style.width = `${cssW}px`;
		this.canvas.style.height = `${cssH}px`;
		this.canvas.width = Math.max(1, Math.round(cssW * dpr));
		this.canvas.height = Math.max(1, Math.round(cssH * dpr));

		// cellSize is in DEVICE pixels; allow true supersampling down to a cell budget.
		const area = this.canvas.width * this.canvas.height;
		const ABS_MAX = 8_000_000;
		const minCell = Math.sqrt(area / ABS_MAX);
		const cell = Math.max(this.cellSize, minCell);
		const w = Math.max(8, Math.round(this.canvas.width / cell));
		const h = Math.max(8, Math.round(this.canvas.height / cell));
		this.w = w;
		this.h = h;
		this.cellCss = this.canvas.width / w / dpr;
		// the resolve target holds a signed coverage field; it must interpolate
		this.resolveFilter = this.gl.LINEAR;
		this.createTargets();
		this.reset();
	}

	stepOnce(): void {
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
	}

	/** Wake a settled sim so it re-relaxes (called when a param changes). */
	wake(): void {
		this.frame = 0;
		this.liveIdle = 0;
		this.liveSettled = false;
		if (this.instant) this.settleNow();
	}

	/**
	 * Jump straight to the settled state instead of animating the intervening
	 * steps. Set true by the "instant" control; `reset()`/`wake()` then call
	 * `settleNow()` so a rebuild or param change renders only the final shape.
	 */
	instant = false;

	/** Run the sim to its settled state in one go (bounded by `settleAt`/idle). */
	settleNow(): void {
		if (this.live) {
			// only a finite live sim has a settled state; open-ended goo has none
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
	}

	/**
	 * True once the sim has stopped advancing (shader: reached `settleAt`; live:
	 * ticked null enough times). A settled field is self-contained in the state
	 * texture, so it can be translated rigidly instead of re-grown.
	 */
	get settled(): boolean {
		return this.material.live ? this.liveSettled : this.frame >= this.settleAt;
	}

	/**
	 * Move this group's *finished* output as a whole by (dx, dy) CSS px, without
	 * re-simulating: the canvas holding the field is translated, so a settled shape
	 * separates from its neighbours like a jigsaw piece. Cleared by `reset()`/
	 * `resize()`. Only meaningful while `settled` (a moving group that is still
	 * growing, or a live group, is rebuilt instead — see the runtime).
	 */
	translateBy(dx: number, dy: number): void {
		this.tx += dx;
		this.ty += dy;
		this.canvas.style.transform = `translate(${this.tx}px, ${this.ty}px)`;
	}

	private clearTransform(): void {
		if (this.tx === 0 && this.ty === 0 && !this.canvas.style.transform) return;
		this.tx = 0;
		this.ty = 0;
		this.canvas.style.transform = "";
	}

	/** Rasterize the registered targets into substrate walls + the active subset. */
	private rasterizeMasks(): { substrate: Uint8Array; active: Uint8Array; ownSubstrate: Uint8Array } {
		const { w, h } = this;
		const substrate = new Uint8Array(w * h);
		const active = new Uint8Array(w * h);
		const ownSubstrate = new Uint8Array(w * h);
		const cell = this.cellCss;
		const scrX = window.scrollX;
		const scrY = window.scrollY;
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
			// a foreign group's box is grown by the aura so we keep clear of it
			const aura = own ? 0 : this.neighborAura;
			const rx = rr.width / 2 + aura;
			const ry = rr.height / 2 + aura;
			const x0 = Math.floor((left - aura) / cell);
			const x1 = Math.max(Math.ceil((right + aura) / cell), x0 + 1);
			const sy0 = Math.floor((top - aura) / cell);
			const sy1 = Math.max(Math.ceil((bottom + aura) / cell), sy0 + 1);
			for (let gx = x0; gx < x1; gx++) {
				for (let sy = sy0; sy < sy1; sy++) {
					const px = (gx + 0.5) * cell;
					const py = (sy + 0.5) * cell;
					if (!insideShape(spec, px, py, cx, cy, rx, ry)) continue;
					const gy = h - 1 - sy;
					if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
					const i = gy * w + gx;
					if (mode !== 'emitter') { substrate[i] = 1; if (own) ownSubstrate[i] = 1; }  // obstacle (active | wall)
					if (mode !== 'wall') active[i] = 1;          // source   (active | emitter)
				}
			}
		};
		for (const { el, mode } of this.targets()) paint(el, mode, true);
		// neighbours from other groups are obstacles only, never sources
		for (const el of this.obstacles()) paint(el, 'wall', false);
		return { substrate, active, ownSubstrate };
	}

	/**
	 * Re-apply element activity after a mode flip. If the live backend can swap its
	 * emit/seed set in place (goo), do that so the fluid/state survives; otherwise
	 * rebuild the seed (field sims must, since their tissue is coupled).
	 */
	refreshActivity(): void {
		const { substrate, active } = this.rasterizeMasks();
		// a live backend that can update its masks in place keeps the sim running for
		// any mode change (goo: SDF + emitters recomputed, fluid untouched)
		if (this.live?.setMasks) {
			this.live.setMasks(substrate, active);
			return;
		}
		this.reset();
	}

	reset(): void {
		const gl = this.gl;
		const { w, h } = this;
		this.clearTransform();       // a rebuild re-rasterizes at true coordinates
		this.frame = 0;              // restart any frame-driven growth animation
		this.clock = 0;
		this.liveIdle = 0;
		this.liveSettled = false;
		this.liveFinite = !!this.material.live?.finite;
		this.settleAt = this.material.settle
			? this.material.settle(this.params)
			: Infinity;
		// A material may expose engine-level knobs as its own params (seed density,
		// cross-group aura); adopt them so an ordinary param slider drives the
		// engine. Absent => keep whatever the runtime set.
		if (typeof this.params.seedChance === 'number') this.seedChance = this.params.seedChance;
		if (typeof this.params.neighborAura === 'number') this.neighborAura = this.params.neighborAura;
		// size the shared tissue map on demand (only tissue materials pay for it) and
		// vacate this group's cells before it regrows
		if (this.occupancy && this.token && this.material.usesOccupancy) {
			const o = this.occupancy;
			if (o.w !== w || o.h !== h || o.owner.length !== w * h) {
				o.w = w;
				o.h = h;
				o.owner = new Int32Array(w * h);
			}
		}
		this.clearOccupancy();

		const { substrate, active, ownSubstrate } = this.rasterizeMasks();

		const ctx = {
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
		this.live?.dispose?.();   // release the previous backend (GPU buffers / wasm sim)
		const data = this.material.live
			? (() => {
					const r = this.material.live!.start(ctx);
					this.live = r.handle;
					return r.initial;
				})()
			: (this.live = null, this.material.seed!(ctx));

		for (const tex of [this.texA, this.texB]) {
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
		}

		const field = this.material.field?.(ctx);
		this.uploadField(field ?? null);

		if (this.instant) this.settleNow();
	}

	private uploadPatch(p: LivePatch): void {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.texA);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, p.x, p.y, p.w, p.h, gl.RGBA, gl.FLOAT, p.data);
	}

	private uploadField(data: Float32Array | null): void {
		const gl = this.gl;
		const { w, h } = this;
		if (!data) {
			if (this.texField) {
				gl.deleteTexture(this.texField);
				this.texField = null;
			}
			return;
		}
		if (!this.texField) {
			const tex = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			this.texField = tex;
		}
		gl.bindTexture(gl.TEXTURE_2D, this.texField);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
	}

	dispose(): void {
		cancelAnimationFrame(this.raf);
		this.live?.dispose?.();
		this.live = null;
		this.clearOccupancy();
	}

	/** Free every cell this group owns in the shared live-tissue map. */
	private clearOccupancy(): void {
		if (!this.material.usesOccupancy || !this.occupancy || !this.token) return;
		const owner = this.occupancy.owner;
		for (let i = 0; i < owner.length; i++) if (owner[i] === this.token) owner[i] = 0;
	}

	private loop = (): void => {
		this.raf = requestAnimationFrame(this.loop);
		if (this.live) {
			if (this.playing && !this.liveSettled) {
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
			}
		} else if (this.playing) {
			// stop stepping once the field has settled (settleAt); wake() restarts it
			for (let i = 0; i < this.speed && this.frame < this.settleAt; i++) this.step();
		}
		this.render();
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

	/** Warn about uniforms the shader declares that no param (or built-in) supplies. */
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
		this.clock++;   // render clock: keeps look animations alive even when the sim is settled

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
		gl.bindVertexArray(this.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
}

function paramsFrom(material: Material): Params {
	const p: Params = {};
	for (const def of material.params) p[def.key] = def.value;
	return p;
}
