import { DIRS, distanceField, normalField, wrapFragment } from '@biomorphic/ca-core';
import type { LivePatch, Material, SeedCtx } from '@biomorphic/ca-core';
import { REACH_OFFSETS, snapDirs } from './reach';

/**
 * TREE — live space colonization (Runions et al. 2007).
 *
 * This is NOT a shader sim. On reset (`live.start`) attractor points are
 * scattered in a crown region outward from each root. Every frame (`tick`) one colonization iteration runs on the
 * CPU: each attractor pulls its nearest node, new nodes are born, and reached
 * attractors are removed. Only the cells that changed are streamed to the GPU
 * as a sub-rectangle patch, so the tree genuinely grows branch by branch.
 *
 * Thickness uses da Vinci's rule: as a node gains descendants its subtree count
 * rises and its radius (and every ancestor's) grows to k*sqrt(subtree), so the
 * trunk thickens *over time* while twigs stay thin — real secondary growth.
 *
 * Channels: r = wood, g = thickness, b = unused, a = substrate.
 */

const SIM = wrapFragment(`
uniform sampler2D u_state;
in vec2 v_uv;
out vec4 outColor;
void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	outColor = fetchAt(u_state, P);      // state is streamed from the CPU
}
`);

const RESOLVE = wrapFragment(`
uniform sampler2D u_state;
uniform float u_maxThick;

in vec2 v_uv;
out vec4 outColor;

void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	vec4 self = fetchAt(u_state, P);

	vec3 twig = vec3(0.48, 0.64, 0.26);
	vec3 trunk = vec3(0.28, 0.16, 0.08);

	// substrate (including filled gaps / crust base) renders as a branch interior
	// (flat => no edge light), so it matches the brown of thick limbs
	if (self.a > 0.5) { outColor = vec4(1.0, trunk * 0.65); return; }

	// leaves: marked b < 0 by the third-stage CA, rendered as fresh green fronds
	if (self.b < -0.5) {
		float lx = fetchAt(u_state, P + ivec2(1,0)).r - fetchAt(u_state, P + ivec2(-1,0)).r;
		float ly = fetchAt(u_state, P + ivec2(0,1)).r - fetchAt(u_state, P + ivec2(0,-1)).r;
		float shade = 0.6 + 0.6 * clamp(length(vec2(lx, ly)), 0.0, 1.0);
		outColor = vec4(1.0, vec3(0.42, 0.70, 0.30) * shade);
		return;
	}

	float fld = self.r * 2.0 - 1.0;
	float t = clamp(self.g / max(u_maxThick, 1.0), 0.0, 1.0);
	vec3 col = mix(twig, trunk, t);

	float gx = fetchAt(u_state, P + ivec2(1,0)).r - fetchAt(u_state, P + ivec2(-1,0)).r;
	float gy = fetchAt(u_state, P + ivec2(0,1)).r - fetchAt(u_state, P + ivec2(0,-1)).r;
	col *= 0.65 + 0.5 * clamp(length(vec2(gx, gy)), 0.0, 1.0);

	outColor = vec4(fld, col);
}
`);

interface Root {
	x: number;
	y: number;
	ox: number;
	oy: number;
}

function chooseRoots(ctx: SeedCtx, substrate: Uint8Array): Root[] {
	const { w, h, seedChance, rand, params } = ctx;
	const active = ctx.active ?? substrate;
	const spacing = params.spacing ?? 16;
	const cands: Root[] = [];
	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			if (substrate[gy * w + gx]) continue;
			let sx = 0;
			let sy = 0;
			let anchor = false;
			for (const [dx, dy] of DIRS) {
				const nx = gx + dx;
				const ny = gy + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (substrate[j]) {
					sx += dx;
					sy += dy;
				}
				if (active[j] && substrate[j]) anchor = true;   // a source WITH a shape
			}
			if (!anchor || (sx === 0 && sy === 0)) continue;
			cands.push({ x: gx, y: gy, ox: -sx, oy: -sy });
		}
	}
	const chosen: Root[] = [];
	const s2 = spacing * spacing;
	for (const c of cands) {
		if (rand() >= seedChance) continue;
		let ok = true;
		for (const o of chosen) {
			const dx = o.x - c.x;
			const dy = o.y - c.y;
			if (dx * dx + dy * dy < s2) {
				ok = false;
				break;
			}
		}
		if (ok) chosen.push(c);
	}
	return chosen;
}

/**
 * A faithful CPU run of the Spikes reach-field CA to its stable shape. Same rule
 * as the Spikes material (spaced seeds, sharpness/curve/roughness/wander/drift),
 * so the field is as spiky as the Spikes page. Restricted to a band near the
 * substrate for speed. Used both as the tree's pre-growth crust (`spike*` params)
 * and as the leaf stage on stable twigs (`leaf*` params) — the same CA, retuned.
 */
interface SpikeCfg {
	height: number;
	sharpness: number;
	curve: number;
	roughness: number;
	wander: number;
	drift: number;
	driftScale: number;
	spacing: number;
	dirs: number;
}

interface SpikeSolver {
	/** Finalize up to `maxPops` nodes; returns cells that became tissue this batch. */
	step(maxPops: number): { cells: number[]; done: boolean };
}

function makeSpikeSolver(
	ctx: SeedCtx,
	substrate: Uint8Array,
	cfg: SpikeCfg,
	active: Uint8Array = substrate,
): SpikeSolver {
	const { w, h, rand } = ctx;
	const height = Math.max(4, cfg.height);
	const sharpness = cfg.sharpness;
	const curve = cfg.curve;
	const roughness = cfg.roughness;
	const wander = cfg.wander;
	const drift = cfg.drift;
	const driftScale = Math.max(1, cfg.driftScale);

	const fract = (v: number) => v - Math.floor(v);
	const hash21 = (x: number, y: number) => {
		const p3 = [fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031)];
		const d = p3[0] * (p3[1] + 33.33) + p3[1] * (p3[2] + 33.33) + p3[2] * (p3[0] + 33.33);
		const q = [p3[0] + d, p3[1] + d, p3[2] + d];
		return fract((q[0] + q[1]) * q[2]);
	};
	const vnoise = (x: number, y: number) => {
		const fx = x / driftScale;
		const fy = y / driftScale;
		const ix = Math.floor(fx);
		const iy = Math.floor(fy);
		const tx = fx - ix;
		const ty = fy - iy;
		const sx = tx * tx * (3 - 2 * tx);
		const sy = ty * ty * (3 - 2 * ty);
		const a = hash21(ix, iy);
		const b = hash21(ix + 1, iy);
		const c = hash21(ix, iy + 1);
		const d = hash21(ix + 1, iy + 1);
		return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
	};

	const lctx: SeedCtx = { ...ctx, substrate, active, params: { ...ctx.params, spacing: cfg.spacing } };
	const blur = Math.min(32, Math.max(2, Math.round(height / Math.max(1, sharpness))));
	const norm = normalField(lctx, blur);
	const dist = distanceField(lctx);

	// spaced seeds, each with a random target budget (endpoints of the needles)
	const seeds = chooseRoots(lctx, substrate);
	const budget = new Float32Array(w * h);
	for (const s of seeds) budget[s.y * w + s.x] = height * (0.6 + rand() * 0.8);

	const cut = height * 1.6 + 8;
	const band = height + 8;
	const f = new Float32Array(w * h).fill(-1e9);

	// max-cost Dijkstra: the reach field is the widest path from a seed, so a
	// max-heap relaxation computes it in O(n log n) instead of repeated sweeps.
	const heapK: number[] = [];
	const heapI: number[] = [];
	const push = (i: number, key: number) => {
		heapK.push(key);
		heapI.push(i);
		let c = heapK.length - 1;
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (heapK[p] >= heapK[c]) break;
			const k = heapK[p];
			heapK[p] = heapK[c];
			heapK[c] = k;
			const iv = heapI[p];
			heapI[p] = heapI[c];
			heapI[c] = iv;
			c = p;
		}
	};
	const pop = (): number => {
		const top = heapI[0];
		const lastK = heapK.pop()!;
		const lastI = heapI.pop()!;
		if (heapK.length > 0) {
			heapK[0] = lastK;
			heapI[0] = lastI;
			let c = 0;
			const n = heapK.length;
			for (;;) {
				const l = 2 * c + 1;
				const r = 2 * c + 2;
				let m = c;
				if (l < n && heapK[l] > heapK[m]) m = l;
				if (r < n && heapK[r] > heapK[m]) m = r;
				if (m === c) break;
				const k = heapK[c];
				heapK[c] = heapK[m];
				heapK[m] = k;
				const iv = heapI[c];
				heapI[c] = heapI[m];
				heapI[m] = iv;
				c = m;
			}
		}
		return top;
	};

	const done = new Uint8Array(w * h);
	for (const s of seeds) {
		const i = s.y * w + s.x;
		const b = budget[i];
		if (b > f[i]) {
			f[i] = b;
			push(i, b);
		}
	}
	const nDirs = snapDirs(cfg.dirs);

	// Dijkstra finalizes nodes in decreasing reach order, so popping in batches
	// grows the field outward from the seeds — the caller can paint each batch to
	// animate the CA step by step instead of jumping to the final shape.
	const step = (maxPops: number): { cells: number[]; done: boolean } => {
		const cells: number[] = [];
		let popped = 0;
		while (heapK.length > 0 && popped < maxPops) {
			const i = pop();
			if (done[i]) continue;
			done[i] = 1;
			popped++;
			if (f[i] >= 0) cells.push(i);
			const x = i % w;
			const y = (i / w) | 0;
			for (let k = 0; k < nDirs; k++) {
				const ox = REACH_OFFSETS[k][0];    // travel i -> j
				const oy = REACH_OFFSETS[k][1];
				const xx = x + ox;
				const yy = y + oy;
				if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
				const j = yy * w + xx;
				if (substrate[j] || done[j] || dist[j] > band) continue;
				// cost is evaluated at the receiving cell j (its normal and jitter)
				let nx = norm[j * 4];
				let ny = norm[j * 4 + 1];
				const na = (hash21(xx, yy) - 0.5) * wander + drift * (vnoise(xx, yy) - 0.5) * 2;
				const ca = Math.cos(na);
				const sa = Math.sin(na);
				const rnx = nx * ca - ny * sa;
				const rny = nx * sa + ny * ca;
				nx = rnx;
				ny = rny;
				const tx = -ny;
				const ty = nx;
				const jit = 1 + roughness * (hash21(xx + 19.3, yy + 7.1) * 2 - 1);
				const len = Math.hypot(ox, oy);
				const ux = ox / len;
				const uy = oy / len;
				const fwd = ux * nx + uy * ny;
				if (fwd < -0.1) continue;
				const side = Math.abs(ux * tx + uy * ty);
				const prog = Math.max(0, Math.min(1, 1 - f[i] / height));
				let sharp = sharpness * (1 + curve * (1 - prog));
				sharp = Math.max(sharp, 0.35);
				const cand = f[i] - len * (Math.max(fwd, 0) + side * sharp * jit);
				if (cand > f[j] && cand > -cut) {
					f[j] = cand;
					push(j, cand);
				}
			}
		}
		return { cells, done: heapK.length === 0 };
	};

	return { step };
}

/** Run the reach field to completion and return its tissue mask (used for `spikes base`). */
function spikeField(ctx: SeedCtx, substrate: Uint8Array, cfg: SpikeCfg, active: Uint8Array = substrate): Uint8Array {
	const solver = makeSpikeSolver(ctx, substrate, cfg, active);
	const base = new Uint8Array(ctx.w * ctx.h);
	for (;;) {
		const r = solver.step(Infinity);
		for (const i of r.cells) base[i] = 1;
		if (r.done) break;
	}
	return base;
}

function liveStart(ctx: SeedCtx): { initial: Float32Array; handle: { tick(): LivePatch | null } } {
	const { w, h, substrate, rand, params } = ctx;

	// shared live-tissue map: refuse to grow into a *foreign* group's branches, and
	// publish our own, so independent trees meet instead of crossing. Off unless the
	// runtime wired a grid that lines up with ours (see CAEngine/Occupancy).
	const occ = ctx.occupancy;
	const me = ctx.token ?? 0;
	const occOn = !!occ && me !== 0 && occ.w === w && occ.h === h;
	// cross-group aura (in cells): refuse to grow within `aura` cells of *foreign*
	// tissue, so neighbouring trees leave a crown-shyness gap. Own tissue is exempt.
	const aura = Math.max(0, Math.round(ctx.neighborAura ?? 0));
	const foreign = (i: number): boolean => {
		if (!occOn) return false;
		const owner = occ!.owner;
		if (aura === 0) return owner[i] !== 0 && owner[i] !== me;
		const x = i % w;
		const y = (i / w) | 0;
		const x0 = Math.max(0, x - aura);
		const x1 = Math.min(w - 1, x + aura);
		const y0 = Math.max(0, y - aura);
		const y1 = Math.min(h - 1, y + aura);
		for (let yy = y0; yy <= y1; yy++) {
			const row = yy * w;
			for (let xx = x0; xx <= x1; xx++) {
				const t = owner[row + xx];
				if (t !== 0 && t !== me) return true;
			}
		}
		return false;
	};
	const claim = (i: number): void => { if (occOn) occ!.owner[i] = me; };

	const height = params.height ?? 110;
	const spread = params.spread ?? 55;
	const attractorCount = Math.round(params.attractors ?? 800);
	const segLen = Math.max(1, params.segLen ?? 2);
	const influence = params.influence ?? 16;
	const kill = params.kill ?? 3;
	const thickScale = params.thickScale ?? 1.0;
	const maxThick = params.maxThick ?? 9;

	const mirror = new Float32Array(w * h * 4);
	// render only OUR OWN box as trunk: foreign obstacles are blocking-only, so a
	// settled tree can translate rigidly without dragging copies of neighbours along.
	const own = ctx.ownSubstrate ?? substrate;
	for (let i = 0; i < w * h; i++) if (own[i]) mirror[i * 4 + 3] = 1;

	let subUse = substrate;
	// spikes base: run the CA crust to a stable shape first, then branch off it.
	// Rendered as THICK WOOD (not flat substrate) so its spiky outline shows.
	if ((params.spikesBase ?? 0) >= 0.5) {
		const base = spikeField(ctx, subUse, {
			height: params.spikeHeight ?? 30,
			sharpness: params.spikeSharp ?? 4,
			curve: params.spikeCurve ?? 0,
			roughness: params.spikeRough ?? 0.6,
			wander: params.spikeWander ?? 0.12,
			drift: params.spikeDrift ?? 0,
			driftScale: params.spikeDriftScale ?? 10,
			spacing: params.spikeSpacing ?? 4,
			dirs: params.spikeDirs ?? 28,
		}, ctx.active ?? ctx.substrate);
		if (subUse === substrate) subUse = substrate.slice();
		const baseThick = Math.max(2, maxThick);
		for (let i = 0; i < w * h; i++) {
			if (base[i]) {
				subUse[i] = 1;                 // roots placed outside the base
				mirror[i * 4] = 1;             // render as wood ...
				mirror[i * 4 + 1] = baseThick; // ... at full thickness (trunk brown)
				claim(i);
			}
		}
	}
	const lctx: SeedCtx = { ...ctx, substrate: subUse };

	const roots = chooseRoots(lctx, subUse);

	// attractors: crown region
	const att: Array<{ x: number; y: number }> = [];
	if (roots.length > 0) {
		const perRoot = Math.max(20, Math.round(attractorCount / roots.length));
		for (const r of roots) {
			const nl = Math.hypot(r.ox, r.oy) || 1;
			const nx = r.ox / nl;
			const ny = r.oy / nl;
			const px = -ny;
			const py = nx;
			for (let i = 0; i < perRoot; i++) {
				const u = Math.sqrt(rand());
				const v = rand() * 2 - 1;
				const cup = u * height;
				const side = v * spread * (0.4 + 0.6 * (1 - u));
				const x = r.x + nx * cup + px * side;
				const y = r.y + ny * cup + py * side;
				if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
				att.push({ x, y });
			}
		}
	}
	// attractors inside an obstacle are unreachable: drop them so they don't keep
	// tugging limbs toward (and into) the wall
	const solid = (x: number, y: number): boolean => {
		const cx = Math.floor(x);
		const cy = Math.floor(y);
		return cx < 0 || cy < 0 || cx >= w || cy >= h || substrate[cy * w + cx] !== 0;
	};
	const alive = att.filter((a) => !solid(a.x, a.y));

	// node arrays
	const nx_: number[] = [];
	const ny_: number[] = [];
	const npar: number[] = [];
	const sub: number[] = [];
	const lastR: number[] = [];
	for (const r of roots) {
		nx_.push(r.x);
		ny_.push(r.y);
		npar.push(-1);
		sub.push(1);
		lastR.push(-1);
	}

	const dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
	const radiusOf = (s: number) => Math.min(maxThick, thickScale * Math.sqrt(s));

	const paint = (cx: number, cy: number, r: number, iter: number) => {
		const R = Math.max(0.6, r);
		const x0 = Math.max(0, Math.floor(cx - R));
		const x1 = Math.min(w - 1, Math.ceil(cx + R));
		const y0 = Math.max(0, Math.floor(cy - R));
		const y1 = Math.min(h - 1, Math.ceil(cy + R));
		for (let gy = y0; gy <= y1; gy++) {
			for (let gx = x0; gx <= x1; gx++) {
				const dx = gx + 0.5 - cx;
				const dy = gy + 0.5 - cy;
				if (dx * dx + dy * dy > R * R) continue;
				const i = gy * w + gx;
				if (substrate[i]) continue;
				if (foreign(i)) continue;        // a neighbour's branch already claims this cell
				mirror[i * 4] = 1;
				claim(i);
				if (r > mirror[i * 4 + 1]) mirror[i * 4 + 1] = r;
				if (mirror[i * 4 + 2] === 0 || iter < mirror[i * 4 + 2]) mirror[i * 4 + 2] = iter;
				if (gx < dirty.x0) dirty.x0 = gx;
				if (gx > dirty.x1) dirty.x1 = gx;
				if (gy < dirty.y0) dirty.y0 = gy;
				if (gy > dirty.y1) dirty.y1 = gy;
			}
		}
	};

	const takePatch = (): LivePatch | null => {
		if (dirty.x1 < dirty.x0 || dirty.y1 < dirty.y0) return null;
		const pw = dirty.x1 - dirty.x0 + 1;
		const ph = dirty.y1 - dirty.y0 + 1;
		const data = new Float32Array(pw * ph * 4);
		for (let y = 0; y < ph; y++) {
			for (let x = 0; x < pw; x++) {
				const si = ((dirty.y0 + y) * w + (dirty.x0 + x)) * 4;
				const di = (y * pw + x) * 4;
				data[di] = mirror[si];
				data[di + 1] = mirror[si + 1];
				data[di + 2] = mirror[si + 2];
				data[di + 3] = mirror[si + 3];
			}
		}
		const p = { x: dirty.x0, y: dirty.y0, w: pw, h: ph, data };
		dirty.x0 = 1e9;
		dirty.y0 = 1e9;
		dirty.x1 = -1;
		dirty.y1 = -1;
		return p;
	};

	// paint the seeds
	for (let i = 0; i < nx_.length; i++) {
		const r = radiusOf(sub[i]);
		lastR[i] = r;
		paint(nx_[i], ny_[i], r, 0);
	}

	const influence2 = influence * influence;
	const kill2 = kill * kill;
	const maxIter = Math.ceil(height / segLen) + 2;
	const bs = Math.max(2, influence);
	const bw = Math.ceil(w / bs) + 1;

	let iter = 0;

	const advance = (): void => {
		iter++;
		if (alive.length === 0) return;
		const grid = new Map<number, number[]>();
		for (let i = 0; i < nx_.length; i++) {
			const key = ((ny_[i] / bs) | 0) * bw + ((nx_[i] / bs) | 0);
			const bucket = grid.get(key);
			if (bucket) bucket.push(i);
			else grid.set(key, [i]);
		}
		const sum = new Map<number, { sx: number; sy: number; n: number }>();
		let any = false;
		for (const a of alive) {
			const bx = (a.x / bs) | 0;
			const by = (a.y / bs) | 0;
			let best = -1;
			let bestD = influence2;
			for (let oy = -1; oy <= 1; oy++) {
				for (let ox = -1; ox <= 1; ox++) {
					const bucket = grid.get((by + oy) * bw + (bx + ox));
					if (!bucket) continue;
					for (const i of bucket) {
						const dx = nx_[i] - a.x;
						const dy = ny_[i] - a.y;
						const d2 = dx * dx + dy * dy;
						if (d2 < bestD) {
							bestD = d2;
							best = i;
						}
					}
				}
			}
			if (best >= 0) {
				const e = sum.get(best) ?? { sx: 0, sy: 0, n: 0 };
				e.sx += a.x - nx_[best];
				e.sy += a.y - ny_[best];
				e.n++;
				sum.set(best, e);
				any = true;
			}
		}
		if (!any) {
			alive.length = 0;
			return;
		}

		const created: number[] = [];
		for (const [i, e] of sum) {
			const len = Math.hypot(e.sx, e.sy) || 1;
			const nxp = nx_[i] + (e.sx / len) * segLen;
			const nyp = ny_[i] + (e.sy / len) * segLen;
			// walls are solid: never birth a node inside an obstacle, so a limb
			// stops at it instead of marching straight through
			const cgx = Math.floor(nxp);
			const cgy = Math.floor(nyp);
			if (cgx < 0 || cgy < 0 || cgx >= w || cgy >= h || substrate[cgy * w + cgx]) continue;
			if (foreign(cgy * w + cgx)) continue;   // don't birth into a neighbour's branch
			nx_.push(nxp);
			ny_.push(nyp);
			npar.push(i);
			sub.push(1);
			lastR.push(-1);
			const ci = nx_.length - 1;
			created.push(ci);

			// da Vinci: every ancestor carries one more tip -> thickens
			let a = i;
			while (a >= 0) {
				sub[a] += 1;
				const r = radiusOf(sub[a]);
				if (r - lastR[a] >= 0.3) {
					lastR[a] = r;
					paint(nx_[a], ny_[a], r, iter);
				}
				a = npar[a];
			}
			const r = radiusOf(1);
			lastR[ci] = r;
			paint(nx_[ci], ny_[ci], r, iter);
		}

		for (let k = alive.length - 1; k >= 0; k--) {
			const a = alive[k];
			for (const ci of created) {
				const dx = nx_[ci] - a.x;
				const dy = ny_[ci] - a.y;
				if (dx * dx + dy * dy < kill2) {
					alive.splice(k, 1);
					break;
				}
			}
		}
	};

	// third stage (optional): once the twigs are stable, run the reach-field CA
	// again on the grown tissue as substrate, at low height, to dress the tree in
	// thin fern-like leaves. It advances a batch of nodes per tick (leafSteps), so
	// the leaves grow live rather than snapping to the final shape. Leaf cells are
	// painted into channel b (negative marker) so resolve can colour them green.
	const leavesOn = (params.leaves ?? 0) >= 0.5;
	const leafSteps = Math.max(1, Math.round(params.leafSteps ?? 60));
	let leafSolver: SpikeSolver | null = null;
	let leavesDone = false;

	const leafStep = (): boolean => {
		if (!leafSolver) {
			const leafSub = new Uint8Array(w * h);
			for (let i = 0; i < w * h; i++) {
				if (mirror[i * 4] > 0.5 && mirror[i * 4 + 3] < 0.5) leafSub[i] = 1;
			}
			leafSolver = makeSpikeSolver(ctx, leafSub, {
				height: params.leafHeight ?? 8,
				sharpness: params.leafSharp ?? 5,
				curve: params.leafCurve ?? 0.2,
				roughness: params.leafRough ?? 0.5,
				wander: params.leafWander ?? 0.6,
				drift: 0,
				driftScale: 10,
				spacing: params.leafSpacing ?? 2,
				dirs: params.leafDirs ?? 28,
			});
		}
		const { cells, done } = leafSolver.step(leafSteps);
		for (const i of cells) {
			if (mirror[i * 4] > 0.5) continue;
			if (foreign(i)) continue;
			const gx = i % w;
			const gy = (i / w) | 0;
			mirror[i * 4] = 1;       // coverage
			claim(i);
			mirror[i * 4 + 1] = 1;   // thin
			mirror[i * 4 + 2] = -1;  // b < 0 marks a leaf
			if (gx < dirty.x0) dirty.x0 = gx;
			if (gx > dirty.x1) dirty.x1 = gx;
			if (gy < dirty.y0) dirty.y0 = gy;
			if (gy > dirty.y1) dirty.y1 = gy;
		}
		return done;
	};

	const handle = {
		tick(): LivePatch | null {
			if (iter < maxIter && alive.length > 0) advance();
			if (leavesOn && !leavesDone && (alive.length === 0 || iter >= maxIter)) {
				if (leafStep()) leavesDone = true;
			}
			return takePatch();
		},
	};

	return { initial: mirror, handle };
}

export const tree: Material = {
	id: 'tree',
	name: 'Tree',
	sim: SIM,
	resolve: RESOLVE,
	speed: 1,
	seed: () => new Float32Array(0),
	live: { start: liveStart, finite: true },
	usesOccupancy: true,
	params: [
		{ key: 'height', label: 'tree height', min: 20, max: 600, step: 4, value: 110, reset: true, kind: 'structure' },
		{ key: 'spread', label: 'canopy spread', min: 10, max: 400, step: 4, value: 55, reset: true, kind: 'structure' },
		{ key: 'attractors', label: 'leaf density', min: 100, max: 12000, step: 100, value: 800, reset: true, kind: 'structure' },
		{ key: 'influence', label: 'influence radius', min: 4, max: 80, step: 1, value: 16, reset: true, kind: 'structure' },
		{ key: 'kill', label: 'kill radius', min: 1, max: 24, step: 1, value: 3, reset: true, kind: 'structure' },
		{ key: 'segLen', label: 'segment length', min: 1, max: 8, step: 1, value: 2, reset: true, kind: 'structure' },
		{ key: 'spacing', label: 'root spacing', min: 1, max: 160, step: 1, value: 3, reset: true, kind: 'structure' },
		{ key: 'seedChance', label: 'seed density', min: 0.05, max: 1, step: 0.05, value: 0.5, reset: true, kind: 'structure' },
		{ key: 'neighborAura', label: 'crown shyness (px)', min: 0, max: 40, step: 1, value: 12, reset: true, kind: 'structure' },
		{ key: 'spikesBase', label: 'spikes base (0/1)', min: 0, max: 1, step: 1, value: 0, reset: true, kind: 'cells' },
		{ key: 'spikeHeight', label: 'spike height', min: 4, max: 400, step: 2, value: 30, reset: true, kind: 'cells' },
		{ key: 'spikeSharp', label: 'spike sharpness', min: 2, max: 16, step: 1, value: 4, reset: true, kind: 'cells' },
		{ key: 'spikeCurve', label: 'spike curve (−convex/+concave)', min: -1, max: 1, step: 0.05, value: 0, reset: true, kind: 'cells' },
		{ key: 'spikeRough', label: 'spike roughness', min: 0, max: 1, step: 0.05, value: 0.6, reset: true, kind: 'cells' },
		{ key: 'spikeWander', label: 'spike wander', min: 0, max: 3, step: 0.05, value: 0.12, reset: true, kind: 'cells' },
		{ key: 'spikeDrift', label: 'spike snake / drift', min: 0, max: 3, step: 0.05, value: 0, reset: true, kind: 'cells' },
		{ key: 'spikeDriftScale', label: 'spike drift scale', min: 2, max: 32, step: 1, value: 10, reset: true, kind: 'cells' },
		{ key: 'spikeSpacing', label: 'spike spacing', min: 1, max: 32, step: 1, value: 4, reset: true, kind: 'cells' },
		{ key: 'spikeDirs', label: 'spike directions', min: 8, max: 48, step: 4, value: 28, reset: true, kind: 'cells' },
		{ key: 'thickScale', label: 'thickness scale', min: 0.4, max: 8, step: 0.1, value: 1.0, reset: true, kind: 'look' },
		{ key: 'maxThick', label: 'max thickness', min: 2, max: 48, step: 1, value: 9, reset: true, kind: 'look' },
		{ key: 'leaves', label: 'leaves CA (0/1)', min: 0, max: 1, step: 1, value: 0, reset: true, kind: 'cells' },
		{ key: 'leafHeight', label: 'leaf height', min: 3, max: 80, step: 1, value: 8, reset: true, kind: 'cells' },
		{ key: 'leafSharp', label: 'leaf sharpness', min: 2, max: 16, step: 1, value: 5, reset: true, kind: 'cells' },
		{ key: 'leafCurve', label: 'leaf slope curve', min: -1, max: 1, step: 0.05, value: 0.2, reset: true, kind: 'cells' },
		{ key: 'leafRough', label: 'leaf roughness', min: 0, max: 1, step: 0.05, value: 0.5, reset: true, kind: 'cells' },
		{ key: 'leafWander', label: 'leaf wander', min: 0, max: 3, step: 0.05, value: 0.6, reset: true, kind: 'cells' },
		{ key: 'leafSpacing', label: 'leaf spacing', min: 1, max: 16, step: 1, value: 2, reset: true, kind: 'cells' },
		{ key: 'leafDirs', label: 'leaf directions', min: 8, max: 48, step: 4, value: 28, reset: true, kind: 'cells' },
		{ key: 'leafSteps', label: 'leaf steps / frame', min: 1, max: 2000, step: 1, value: 60, kind: 'cells' },
	],
	sections: [
		{
			id: 'base',
			label: 'spikes base (pre-growth)',
			keys: [
				'spikesBase', 'spikeHeight', 'spikeSharp', 'spikeCurve',
				'spikeRough', 'spikeWander', 'spikeDrift', 'spikeDriftScale',
				'spikeSpacing', 'spikeDirs',
			],
		},
		{
			id: 'growth',
			label: 'tree growth',
			keys: [
				'height', 'spread', 'attractors', 'influence', 'kill', 'segLen',
				'spacing', 'seedChance', 'neighborAura', 'thickScale', 'maxThick',
			],
		},
		{
			id: 'leaves',
			label: 'leaves (CA on twigs)',
			keys: [
				'leaves', 'leafHeight', 'leafSharp', 'leafCurve', 'leafRough',
				'leafWander', 'leafSpacing', 'leafDirs', 'leafSteps',
			],
		},
	],
};
