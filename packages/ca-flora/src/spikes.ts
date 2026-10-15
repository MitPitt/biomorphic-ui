import { DIRS, normalField, T, wrapFragment } from '@bio/ca-core';
import type { Material, SeedCtx } from '@bio/ca-core';
import { reachOffsetsGLSL, SNAP_DIRS_GLSL } from './reach';

/**
 * SPIKES — stalagmites as a continuous reach field.
 *
 * There is no binary "alive" flag. Every free cell holds a scalar reach value
 * `f = budget - accumulated_cost`, propagated outward from the seeds by a
 * local max-plus update (a CA): `f = max over reachable neighbours of
 * (neighbour.f - step_cost)`. A cell is tissue exactly when `f >= 0`. Because
 * the field is continuous and linear near the front, the renderer can
 * interpolate it and threshold at canvas resolution, so the silhouette is a
 * smooth contour rather than a lattice staircase.
 *
 * Cost: outward step = 1, sideways step = sharpness (a cone: budget tall,
 * budget/sharpness wide). Seeded budgets grow over time so the front is always
 * a pointed, self-similar cone. Direction comes from a smoothed normal field.
 *
 * Channels: r = 1 for SUBSTRATE else 0, g = reach field, b = current budget,
 *           a = target budget (seeds only).
 */

const SIM = wrapFragment(`
uniform sampler2D u_state;
uniform sampler2D u_field;
uniform float u_height;
uniform float u_sharpness;
uniform float u_curve;
uniform float u_roughness;
uniform float u_wander;
uniform float u_drift;
uniform float u_driftScale;
uniform float u_dirs;

in vec2 v_uv;
out vec4 outColor;

${reachOffsetsGLSL()}

void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	vec4 self = fetchAt(u_state, P);
	if (int(self.r + 0.5) == 1) { outColor = self; return; }   // substrate is frozen

	vec2 nrm = texelFetch(u_field, P, 0).rg;
	if (dot(nrm, nrm) < 0.25) { outColor = self; return; }
	nrm = normalize(nrm);
	float a = (hash21(vec2(P)) - 0.5) * u_wander;
	a += u_drift * (vnoise(vec2(P) / max(u_driftScale, 1.0)) - 0.5) * 2.0;
	float cs = cos(a);
	float sn = sin(a);
	nrm = vec2(nrm.x * cs - nrm.y * sn, nrm.x * sn + nrm.y * cs);
	vec2 tan = vec2(-nrm.y, nrm.x);

	float hgt = u_height;
	float sharpness = u_sharpness;
	float crv = u_curve;
	float cut = hgt * 1.6 + 8.0;      // finite support -> the field converges
	${SNAP_DIRS_GLSL}
	float best = -1e9;
	for (int i = 0; i < n; i++) {
		ivec2 off = OFFS[i];
		vec4 nb = fetchAt(u_state, P + off);
		if (int(nb.r + 0.5) == 1) continue;        // substrate blocks
		if (nb.g < -cut) continue;                 // too far to matter

		float len = length(vec2(off));
		vec2 u = -vec2(off) / len;                 // neighbour -> here (unit)
		float fwd = dot(u, nrm);
		if (fwd < -0.1) continue;                  // never flow back toward the box
		float side = abs(dot(u, tan));

		float prog = clamp(1.0 - nb.g / max(hgt, 1.0), 0.0, 1.0);
		float sharp = sharpness * (1.0 + crv * (1.0 - prog));
		sharp = max(sharp, 0.35);
		float jit = 1.0 + u_roughness * (hash21(vec2(P) + vec2(19.3, 7.1)) * 2.0 - 1.0);

		float cost = len * (max(fwd, 0.0) + side * sharp * jit);
		best = max(best, nb.g - cost);
	}
	best = max(best, -cut - 1.0);
	float outB = self.b;
	if (self.a > 0.5) {                            // a seed grows its budget over
		outB = min(self.b + 1.0, self.a);           // time, so the front is always a
		best = max(best, outB);                     // pointed, self-similar cone
	}
	outColor = vec4(0.0, best, outB, self.a);
}
`);

const RESOLVE = wrapFragment(`
uniform sampler2D u_state;
uniform float u_height;
uniform float u_sharpness;
uniform float u_style;
uniform float u_frame;

in vec2 v_uv;
out vec4 outColor;

float occ(sampler2D st, ivec2 c) {
	vec4 s = fetchAt(st, c);
	if (int(s.r + 0.5) == 1) return 0.0;
	return s.g >= 0.0 ? 1.0 : 0.0;
}

// One material shader for both tissue and interior fill; N is the fake normal.
vec3 shade(int style, vec3 N, float edge, float dens, float p, ivec2 P) {
	vec3 V = vec3(0.0, 0.0, 1.0);
	float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
	vec3 L1 = normalize(vec3(-0.5, 0.7, 0.6));
	vec3 R = reflect(-V, N);
	float thin = 1.0 - smoothstep(0.5, 0.95, dens);
	vec3 col;
	if (style == 1 || style == 2) {
		float flow = (vnoise(vec2(P) * 0.08 + vec2(0.0, u_frame * 0.03)) - 0.5) * 0.3;
		vec3 sky = style == 2 ? vec3(1.0, 0.86, 0.55) : vec3(0.85, 0.92, 1.0);
		vec3 gnd = style == 2 ? vec3(0.22, 0.13, 0.04) : vec3(0.03, 0.03, 0.05);
		vec3 env = mix(gnd, sky, clamp(R.y * 0.5 + 0.5 + flow, 0.0, 1.0));
		env += (style == 2 ? vec3(0.5, 0.4, 0.2) : vec3(0.55)) * exp(-pow((R.y - 0.05) * 7.0, 2.0));
		float spec = pow(clamp(dot(R, L1), 0.0, 1.0), 24.0);
		float diff = clamp(dot(N, L1), 0.0, 1.0);
		col = env * (0.6 + 0.4 * diff) + vec3(1.0) * spec;
		col += fres * (style == 2 ? vec3(1.0, 0.9, 0.6) : vec3(0.75, 0.85, 1.0)) * 0.6;
		col = mix(col, style == 2 ? vec3(1.0, 0.95, 0.8) : vec3(0.9, 0.95, 1.0), edge * 0.5);
	} else if (style == 3) {
		float glow = max(edge, smoothstep(0.6, 1.0, p) * thin);
		col = mix(vec3(0.02, 0.01, 0.04), vec3(0.10, 0.8, 1.0), glow);
		col += vec3(0.8, 0.1, 0.9) * pow(glow, 4.0) * 0.6;
		col += fres * vec3(0.2, 0.8, 1.0) * 0.5;
	} else if (style == 4) {
		vec3 ice = mix(vec3(0.55, 0.75, 0.9), vec3(0.85, 0.95, 1.0), p);
		float spec = pow(clamp(dot(R, L1), 0.0, 1.0), 80.0);
		col = ice * (0.5 + 0.5 * clamp(dot(N, L1), 0.0, 1.0)) + vec3(spec);
		col += fres * vec3(0.8, 0.95, 1.0) * 0.8;
		col = mix(col, vec3(1.0), edge * 0.7);
	} else {
		vec3 dark = vec3(0.045, 0.045, 0.055);
		vec3 bone = vec3(0.93, 0.91, 0.85);
		float tip = smoothstep(0.70, 1.0, p) * thin;
		float lit = 0.72 + 0.28 * clamp(dot(N, L1), 0.0, 1.0);
		col = mix(dark, bone, max(edge, tip)) * lit;
		col = mix(col, vec3(0.42, 0.045, 0.06), (1.0 - edge) * smoothstep(0.2, 0.7, 1.0 - p) * 0.35);
	}
	return col;
}

void main() {
	ivec2 P = ivec2(gl_FragCoord.xy);
	int style = int(u_style + 0.5);
	vec3 rim = style == 3 ? vec3(0.3, 0.9, 1.0)
		: style == 4 ? vec3(0.85, 0.95, 1.0)
		: style == 2 ? vec3(1.0, 0.95, 0.8)
		: style == 1 ? vec3(0.9, 0.95, 1.0)
		: vec3(0.93, 0.91, 0.85);

	vec4 self = fetchAt(u_state, P);
	if (int(self.r + 0.5) == 1) {                 // frozen substrate: nothing to draw
		outColor = vec4(-1.0, 0.0, 0.0, 0.0);
		return;
	}

	float scale = max(u_sharpness, 1.0);
	float fld = clamp(self.g / scale, -1.0, 1.0);

	float ox = occ(u_state, P + ivec2(1,0)) - occ(u_state, P + ivec2(-1,0));
	float oy = occ(u_state, P + ivec2(0,1)) - occ(u_state, P + ivec2(0,-1));
	float e = clamp(length(vec2(ox, oy)), 0.0, 1.0);
	float edge = smoothstep(0.45, 1.1, e);

	float dens = 0.0;
	for (int dy = -1; dy <= 1; dy++)
		for (int dx = -1; dx <= 1; dx++) {
			if (dx == 0 && dy == 0) continue;
			dens += occ(u_state, P + ivec2(dx, dy));
		}
	dens /= 8.0;

	float p = 1.0 - clamp(self.g / max(u_height, 1.0), 0.0, 1.0);  // 0 base -> 1 tip

	// Fake surface normal: treat the reach value as a height field, so a spike
	// reads as a rounded 3D ridge whose slopes catch light.
	float gL = fetchAt(u_state, P + ivec2(-1, 0)).g;
	float gR = fetchAt(u_state, P + ivec2(1, 0)).g;
	float gD = fetchAt(u_state, P + ivec2(0, -1)).g;
	float gU = fetchAt(u_state, P + ivec2(0, 1)).g;
	vec2 grad = vec2(gR - gL, gU - gD) / max(u_height, 1.0);
	vec3 N = normalize(vec3(-grad * 3.0, 0.5));

	vec3 col = shade(style, N, edge, dens, p, P);
	if (self.g < 0.0) col = rim;   // outside the front: rim colour into the AA band
	outColor = vec4(fld, col);
}
`);

function pickSpaced(
	cands: Array<{ x: number; y: number }>,
	spacing: number,
	seedChance: number,
	rand: () => number,
): Array<{ x: number; y: number }> {
	const chosen: Array<{ x: number; y: number }> = [];
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

/** Seed free cells touching an ACTIVE substrate cell, spaced, each with a random budget. */
function seedEdges(ctx: SeedCtx, budget: (rand: () => number) => number): Float32Array {
	const { w, h, substrate, seedChance, rand, params } = ctx;
	const active = ctx.active ?? substrate;
	const out = new Float32Array(w * h * 4);
	const spacing = Math.max(1, params.spacing ?? 4);
	for (let i = 0; i < w * h; i++) {
		if (substrate[i]) out[i * 4] = T.SUBSTRATE;
		else out[i * 4 + 1] = -1e9;
	}
	const cands: Array<{ x: number; y: number }> = [];
	for (let gy = 0; gy < h; gy++) {
		for (let gx = 0; gx < w; gx++) {
			const i = gy * w + gx;
			if (substrate[i]) continue;
			let touches = false;
			for (const [dx, dy] of DIRS) {
				const nx = gx + dx;
				const ny = gy + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (active[j] && substrate[j]) {   // a source WITH a shape (both-mode)
					touches = true;
					break;
				}
			}
			if (touches) cands.push({ x: gx, y: gy });
		}
	}
	for (const c of pickSpaced(cands, spacing, seedChance, rand)) {
		const idx = c.y * w + c.x;
		out[idx * 4 + 1] = 0;            // reach starts empty
		out[idx * 4 + 2] = 0;            // current budget
		out[idx * 4 + 3] = budget(rand); // target budget
	}
	return out;
}

function seed(ctx: SeedCtx): Float32Array {
	const height = ctx.params.height ?? 26;
	return seedEdges(ctx, (rand) => height * (0.6 + rand() * 0.8));
}

export const spikes: Material = {
	id: 'spikes',
	name: 'Spikes',
	sim: SIM,
	resolve: RESOLVE,
	speed: 2,
	seed,
	// The reach field is finite: seed budgets grow by 1/tick up to ~1.4*height, and
	// the front propagates within that budget, so 3*height ticks is a safe upper
	// bound on settling. After that the engine stops stepping until a param wakes it.
	settle: (p) => Math.ceil(3 * (p.height ?? 26)) + 48,
	field: (ctx) =>
		normalField(
			ctx,
			Math.min(32, Math.max(2, Math.round((ctx.params.height ?? 26) / Math.max(1, ctx.params.sharpness ?? 4)))),
		),
	params: [
		{ key: 'height', label: 'spike height', min: 4, max: 1000, step: 2, value: 26, reset: true },
		{ key: 'sharpness', label: 'sharpness (thinner)', min: 2, max: 16, step: 1, value: 4 },
		{ key: 'curve', label: 'slope curve (−convex / +concave)', min: -1, max: 1, step: 0.05, value: 0 },
		{ key: 'roughness', label: 'edge roughness', min: 0, max: 1, step: 0.05, value: 0.6 },
		{ key: 'wander', label: 'wander (rough edge)', min: 0, max: 3, step: 0.05, value: 0.12 },
		{ key: 'drift', label: 'snake / drift', min: 0, max: 3, step: 0.05, value: 0, kind: 'look' },
		{ key: 'driftScale', label: 'drift scale', min: 2, max: 32, step: 1, value: 10, kind: 'look' },
		{ key: 'spacing', label: 'seed spacing', min: 1, max: 32, step: 1, value: 4, reset: true },
		{ key: 'seedChance', label: 'seed density', min: 0.05, max: 1, step: 0.05, value: 0.5, reset: true, kind: 'structure' },
		{ key: 'dirs', label: 'growth directions', min: 8, max: 48, step: 4, value: 28, kind: 'look' },
		{ key: 'style', label: 'style (bone/metal/gold/neon/ice)', min: 0, max: 4, step: 1, value: 0, kind: 'look' },
	],
};