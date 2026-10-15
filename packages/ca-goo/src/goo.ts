import { wrapFragment } from '@bio/ca-core';
import type { LiveHandle, LivePatch, Material, SeedCtx } from '@bio/ca-core';
import { WebGpuGoo } from './goo-webgpu';
import wasmUrl from './goo.wasm?url';

/**
 * GOO — live position-based (PBD) liquid.
 *
 * The DOM/canvas stays in JS and WebGL2; the sim is one of two interchangeable
 * backends behind the `live` seam:
 *
 *  - **WebGPU** (preferred when available): the whole solver, emission, culling
 *    and the metaball splat run on the GPU; only the density field is read back,
 *    throttled and non-blocking. See `goo-webgpu.ts` / `goo.wgsl`.
 *  - **wasm** (fallback): the hand-rolled Clavet-style PBD fluid in
 *    `crates/goo`, compiled to wasm32 (`npm run wasm`). Verified without a GPU.
 *
 * Substrate cells are frozen; free cells touching them emit goo onto a
 * rest-spacing lattice. Gravity drags the mass down and position-based density
 * relaxation keeps it (roughly) incompressible, so the goo pools, necks and
 * drips, with wall adhesion holding it onto box edges.
 *
 * Channels: r = substrate flag, g = goo density, b/a = unused.
 *
 * Both backends load asynchronously; `tick` returns null until ready. `reset`
 * (resize / material switch) rebuilds behind a generation guard.
 */

const SIM = wrapFragment(`
uniform sampler2D u_state;
in vec2 v_uv;
out vec4 outColor;
void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	outColor = fetchAt(u_state, P);      // state is streamed from the fluid sim
}
`);

const RESOLVE = wrapFragment(`
uniform sampler2D u_state;
uniform float u_threshold;

in vec2 v_uv;
out vec4 outColor;

void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	vec4 self = fetchAt(u_state, P);
	if (self.r > 0.5) { outColor = vec4(-1.0, 0.0, 0.0, 0.0); return; }

	float d = self.g;
	float lo = u_threshold * 0.55;
	float hi = u_threshold * 1.35;
	float a = smoothstep(lo, hi, d);

	// fake surface normal from the density gradient (blobs read as rounded)
	float dx = fetchAt(u_state, P + ivec2(1,0)).g - fetchAt(u_state, P + ivec2(-1,0)).g;
	float dy = fetchAt(u_state, P + ivec2(0,1)).g - fetchAt(u_state, P + ivec2(0,-1)).g;
	vec3 n = normalize(vec3(-dx, -dy, 0.85));
	vec3 l = normalize(vec3(-0.35, 0.5, 0.79));
	float diff = clamp(dot(n, l), 0.0, 1.0);
	float spec = pow(max(dot(n, normalize(l + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
	float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);

	vec3 deep = vec3(0.05, 0.15, 0.03);
	vec3 shallow = vec3(0.36, 0.78, 0.18);
	vec3 col = mix(deep, shallow, clamp((d - lo) / max(hi - lo, 1e-3), 0.0, 1.0));
	col = col * (0.5 + 0.65 * diff) + spec * 0.9 + fres * vec3(0.35, 0.6, 0.25);

	outColor = vec4(clamp(a * 2.0 - 1.0, -1.0, 1.0), col);
}
`);

interface GooExports {
	memory: WebAssembly.Memory;
	goo_input_reserve(n: number): number;
	goo_new(w: number, h: number, particleRadius: number, maxParticles: number): number;
	goo_set(handle: number, key: number, value: number): void;
	goo_tick(handle: number, dt: number): number;
	goo_particle_count(handle: number): number;
	goo_free(handle: number): void;
}

/** Fixed sim timestep per tick. The engine runs `speed` ticks per frame. */
const DT = 1 / 60;
/** Param keys pushed to the wasm sim each tick, in the crate's `goo_set` order. */
const SIM_KEYS = ['emit', 'gravity', 'viscosity', 'stiffness', 'tension', 'sticky', 'blob'] as const;

let modulePromise: Promise<WebAssembly.Module> | null = null;
function wasmModule(): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = fetch(wasmUrl)
			.then((r) => r.arrayBuffer())
			.then((bytes) => WebAssembly.compile(bytes));
	}
	return modulePromise;
}

// One lazily-instantiated wasm module shared by every sim handle (each `goo_new`
// clones the shared input buffer synchronously, so multiple sims coexist).
let exports_: GooExports | null = null;

function buildInitial(w: number, h: number, substrate: Uint8Array): Float32Array {
	const out = new Float32Array(w * h * 4);
	for (let i = 0; i < w * h; i++) if (substrate[i]) out[i * 4] = 1;
	return out;
}

function startWasm(ctx: SeedCtx): { initial: Float32Array; handle: LiveHandle } {
	const { w, h, substrate, params } = ctx;
	const initial = buildInitial(w, h, substrate);
	const particleRadius = Math.max(0.6, params.particleRadius ?? 1);
	const maxParticles = Math.max(200, Math.round(params.maxParticles ?? 3000));

	// Each handle owns its sim; disposal (on the next reset / teardown) frees it, so
	// several goo groups can run at once without clobbering each other.
	let sim = 0;
	let disposed = false;
	wasmModule()
		.then((mod) => {
			if (disposed) return; // superseded by a newer reset before the module loaded
			if (!exports_) exports_ = new WebAssembly.Instance(mod, {}).exports as unknown as GooExports;
			const ex = exports_;
			const ptr = ex.goo_input_reserve(w * h);
			new Uint8Array(ex.memory.buffer, ptr, w * h).set(substrate);
			sim = ex.goo_new(w, h, particleRadius, maxParticles);
		})
		.catch((err) => console.error('[goo] failed to load wasm', err));

	const handle: LiveHandle = {
		tick(): LivePatch | null {
			const ex = exports_;
			if (!ex || !sim) return null;
			for (let i = 0; i < SIM_KEYS.length; i++) ex.goo_set(sim, i, params[SIM_KEYS[i]] ?? 0);
			const ptr = ex.goo_tick(sim, DT);
			if (!ptr) return null;
			const dv = new DataView(ex.memory.buffer);
			const x = dv.getFloat32(ptr, true) | 0;
			const y = dv.getFloat32(ptr + 4, true) | 0;
			const pw = dv.getFloat32(ptr + 8, true) | 0;
			const ph = dv.getFloat32(ptr + 12, true) | 0;
			if (pw <= 0 || ph <= 0) return null;
			const src = new Float32Array(ex.memory.buffer, ptr + 16, pw * ph * 4);
			return { x, y, w: pw, h: ph, data: src.slice() };
		},
		dispose(): void {
			disposed = true;
			if (sim && exports_) {
				exports_.goo_free(sim);
				sim = 0;
			}
		},
	};

	return { initial, handle };
}

function startGoo(ctx: SeedCtx): { initial: Float32Array; handle: LiveHandle } {
	const wantGpu = (ctx.params.backend ?? 1) >= 0.5;
	if (wantGpu && typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
		const gpu = new WebGpuGoo(ctx, () => startWasm(ctx).handle);
		return { initial: buildInitial(ctx.w, ctx.h, ctx.substrate), handle: gpu.handle };
	}
	return startWasm(ctx);
}

export const goo: Material = {
	id: 'goo',
	name: 'Goo',
	coupled: true,   // one fluid: the runtime keeps all targets in a single group
	sim: SIM,
	resolve: RESOLVE,
	speed: 2,
	live: { start: startGoo },
	params: [
		{ key: 'emit', label: 'emission rate', min: 0, max: 3000, step: 10, value: 300, kind: 'cells' },
		{ key: 'gravity', label: 'gravity', min: 0, max: 200, step: 1, value: 20, kind: 'cells' },
		{ key: 'viscosity', label: 'viscosity', min: 0, max: 12, step: 0.05, value: 0.5, kind: 'cells' },
		{ key: 'stiffness', label: 'stiffness', min: 0, max: 200, step: 1, value: 60, kind: 'cells' },
		{ key: 'tension', label: 'surface tension', min: 0, max: 0.8, step: 0.005, value: 0.04, kind: 'cells' },
		{ key: 'sticky', label: 'wall stickiness', min: 0, max: 1500, step: 5, value: 60, kind: 'cells' },
		{ key: 'blob', label: 'blob radius', min: 1.5, max: 10, step: 0.1, value: 3.8, kind: 'look' },
		{ key: 'threshold', label: 'goo threshold', min: 0.5, max: 8, step: 0.05, value: 1.7, kind: 'look' },
		{ key: 'particleRadius', label: 'particle size', min: 0.6, max: 3, step: 0.1, value: 1.0, reset: true, kind: 'look' },
		{ key: 'maxParticles', label: 'max particles', min: 200, max: 100000, step: 100, value: 3000, reset: true, kind: 'cells' },
		{ key: 'backend', label: 'gpu (1) / cpu (0)', min: 0, max: 1, step: 1, value: 1, reset: true, kind: 'cells' },
	],
};
