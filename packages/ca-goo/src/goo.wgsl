// Goo: GPU-resident position-based (PBD) fluid, ported 1:1 from crates/goo.
//
// Design notes (why this is shaped the way it is):
//  * Every particle field lives on the GPU. Emission, culling and the metaball
//    splat are GPU passes too, so the CPU never has to read particle positions
//    back each tick (that round-trip is what made the first GPU attempt slower
//    than the wasm solver).
//  * The pair passes are written as *gathers*: each particle sums over its
//    neighbours and writes only its own accumulator. That is mathematically
//    identical to the scatter formulation (all pair terms are symmetric) but
//    needs no floating-point atomics, which WebGPU does not have.
//  * The only u32 atomics: a fixed-capacity bucket grid (hashed by cell), a
//    free-list allocator, an emission accumulator, and the fixed-point
//    momentum sum for surface tension. The metaball field is also accumulated
//    in fixed point.
//  * Only the density field is read back, throttled (PATCH_EVERY) and pipelined
//    on the CPU side; nothing blocks on the GPU.

const SMOOTHING: f32 = 3.0;
const REST_SPACING: f32 = 1.7888544;
const MAX_DISP: f32 = 0.35;
const MAX_DISP_TOTAL: f32 = 0.12;
const MAX_SPEED: f32 = 55.0;
const NEAR_K: f32 = 0.3;

const EMIT_TRIES: u32 = 12u;     // emitter retries per spawn (matches the cpu)
const EMIT_SEARCH: i32 = 3;      // lattice half-window for attach search
const EMIT_SCALE: f32 = 256.0;   // fixed-point scale for the emit accumulator
const MEAN_SCALE: f32 = 4096.0;  // fixed-point scale for the momentum sum
const MVX_SCALE: f32 = 64.0;     // fixed-point scale for the net-velocity sum
const INVALID: u32 = 0xffffffffu;

// Uniform offsets (index into the `U` storage array). Keep in sync with goo-webgpu.ts.
const U_W = 0u;
const U_H = 1u;
const U_GW = 2u;
const U_GH = 3u;
const U_HR = 4u;
const U_HR2 = 5u;
const U_DT = 6u;
const U_DT2 = 7u;
const U_GRAV = 8u;
const U_VISC = 9u;
const U_STIFF = 10u;
const U_TENS = 11u;
const U_STICKY = 12u;
const U_BLOB = 13u;
const U_RESTD = 14u;
const U_R = 15u;
const U_NUMCELLS = 16u;
const U_MAXPART = 17u;
const U_SP = 18u;
const U_OFF = 19u;
const U_LGW = 20u;
const U_LGH = 21u;
const U_EMIT = 22u;
const U_SPLAT = 23u;
const U_TICK = 24u;
const U_EMITN = 25u;   // active emitter count (the Emit buffer is sized to capacity)

// Counter slots (u32 atomics).
const C_ALIVE = 0u;
const C_TOP = 1u;
const C_FREE = 2u;
const C_EMIT_ACC = 3u;
const C_MEANX = 4u;
const C_MEANY = 5u;
const C_SPAWN = 6u;
const C_MVX = 7u;
const C_MVY = 8u;

struct Particle {
	pos: vec2<f32>,
	prev: vec2<f32>,
	vel: vec2<f32>,
	vel2: vec2<f32>,
	alive: u32,
	pad: u32,
};

struct AuxData {
	dn: vec4<f32>,   // density, near_density, pressure, near_pressure
	nrm: vec2<f32>,  // density-gradient normal (unit, or zero off-surface)
	sum: vec2<f32>,  // neighbour position sum
	cd: vec2<f32>,   // neighbour count, disp.x
	dp: vec2<f32>,   // disp.y, pad
};

@group(0) @binding(0) var<storage, read_write> Particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> Aux: array<AuxData>;
@group(0) @binding(2) var<storage, read_write> GridHead: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> GridNext: array<u32>;
@group(0) @binding(4) var<storage, read> Emit: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> Lat: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> Field: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> Sdf: array<f32>;
@group(0) @binding(8) var<storage, read> Deep: array<u32>;
@group(0) @binding(10) var<storage, read_write> Counter: array<atomic<u32>, 10>;
@group(0) @binding(11) var<storage, read_write> Free: array<u32>;
@group(0) @binding(12) var<storage, read> U: array<f32>;

fn pcg(v: u32) -> u32 {
	var x = v * 747796405u + 2891336453u;
	let m = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
	return (m >> 22u) ^ m;
}

fn is_alive(i: u32) -> bool {
	return Particles[i].alive != 0u;
}

fn sdf_at(p: vec2<f32>) -> f32 {
	let x = clamp(i32(floor(p.x)), 0, i32(U[U_W]) - 1);
	let y = clamp(i32(floor(p.y)), 0, i32(U[U_H]) - 1);
	return Sdf[u32(y) * u32(U[U_W]) + u32(x)];
}

fn sdf_normal(p: vec2<f32>) -> vec2<f32> {
	let gx = sdf_at(vec2<f32>(p.x + 1.0, p.y)) - sdf_at(vec2<f32>(p.x - 1.0, p.y));
	let gy = sdf_at(vec2<f32>(p.x, p.y + 1.0)) - sdf_at(vec2<f32>(p.x, p.y - 1.0));
	let l = sqrt(gx * gx + gy * gy);
	if (l < 1.0e-5) {
		return vec2<f32>(0.0, 1.0);
	}
	return vec2<f32>(gx / l, gy / l);
}

fn cell_coords(p: vec2<f32>) -> vec2<i32> {
	let cx = clamp(i32(floor(p.x / U[U_HR])), 0, i32(U[U_GW]) - 1);
	let cy = clamp(i32(floor(p.y / U[U_HR])), 0, i32(U[U_GH]) - 1);
	return vec2<i32>(cx, cy);
}

// ---------------------------------------------------------------------------
// Per-tick bookkeeping: reset the momentum sum and advance the emit accumulator.
// ---------------------------------------------------------------------------
@compute @workgroup_size(1)
fn cs_emit_accum() {
	atomicStore(&Counter[C_MEANX], 0u);
	atomicStore(&Counter[C_MEANY], 0u);
	atomicStore(&Counter[C_MVX], 0u);
	atomicStore(&Counter[C_MVY], 0u);
	let inc = u32(round(U[U_EMIT] * U[U_DT] * EMIT_SCALE));
	let prev = atomicAdd(&Counter[C_EMIT_ACC], inc);
	let acc = prev + inc;
	let want = acc / u32(EMIT_SCALE);
	atomicStore(&Counter[C_EMIT_ACC], acc - want * u32(EMIT_SCALE));
	let alive = atomicLoad(&Counter[C_ALIVE]);
	let maxp = u32(U[U_MAXPART]);
	var s = want;
	if (s > maxp - min(alive, maxp)) {
		s = maxp - min(alive, maxp);
	}
	// The emit pass dispatches a fixed 256 threads; clamp to that.
	if (s > 256u) {
		s = 256u;
	}
	atomicStore(&Counter[C_SPAWN], s);
}

// ---------------------------------------------------------------------------
// Uniform grid: per-cell singly linked lists (head + next). No capacity limit,
// so highly compressed goo never has its neighbour list truncated (a fixed cap
// undercounts density and cascades into overlapping, exploding goo).
// ---------------------------------------------------------------------------
// Grid-stride clears: the range (cells / lattice / field) can exceed the
// default maxComputeWorkgroupsPerDimension of 65535 on large pages, so each
// dispatch is capped and threads walk the range in strides.
fn clear_stride(n: u32) -> u32 {
	return min((n + 63u) / 64u, 65535u) * 64u;
}

@compute @workgroup_size(64)
fn cs_clear_grid(@builtin(global_invocation_id) g: vec3<u32>) {
	let n = u32(U[U_NUMCELLS]);
	let stride = clear_stride(n);
	var i = g.x;
	loop {
		if (i >= n) {
			break;
		}
		atomicStore(&GridHead[i], INVALID);
		i = i + stride;
	}
}

@compute @workgroup_size(64)
fn cs_build_grid(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let c = cell_coords(Particles[i].pos);
	let cell = u32(c.y) * u32(U[U_GW]) + u32(c.x);
	// Push-front; the previous head becomes this particle's "next".
	GridNext[i] = atomicExchange(&GridHead[cell], i);
}

// ---------------------------------------------------------------------------
// Forces: gravity + wall adhesion, then copy vel -> vel2 for the viscosity pass.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_integrate(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	var p = Particles[i].pos;
	var v = Particles[i].vel;
	v.y = v.y - U[U_GRAV] * U[U_DT];
	let adhesion = (U[U_STICKY] / 100.0) * 60.0;
	if (adhesion > 0.0) {
		// Rest-distance adhesion: zero at the particle's resting gap (r*0.9, the
		// collision margin) and rising with separation. A pull that is strongest
		// *at* the wall pumps particles into it, and collision bounces them back
		// out -- an energy source that makes the fluid self-propel at large radii.
		let reach = U[U_HR] * 0.7;
		let rest = U[U_R] * 0.9;
		let s = sdf_at(p);
		if (s > rest && s < reach) {
			let nrm = sdf_normal(p);
			let wgt = 1.0 - (s - rest) / (reach - rest);
			let a = adhesion * wgt * U[U_DT];
			v = v - nrm * a;
		}
	}
	Particles[i].vel = v;
	Particles[i].vel2 = v;
}

// ---------------------------------------------------------------------------
// Viscosity (explicit, gather on velocities).
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_viscosity(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let sigma = U[U_VISC];
	let pi = Particles[i].pos;
	let vi = Particles[i].vel;
	if (sigma <= 0.0) {
		Particles[i].vel2 = vi;
		return;
	}
	let hr = U[U_HR];
	let h2 = U[U_HR2];
	let gw = i32(U[U_GW]);
	let gh = i32(U[U_GH]);
	let c = cell_coords(pi);
	var acc = vec2<f32>(0.0, 0.0);
	for (var dy = -1; dy <= 1; dy = dy + 1) {
		let ny = c.y + dy;
		if (ny < 0 || ny >= gh) {
			continue;
		}
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let nx = c.x + dx;
			if (nx < 0 || nx >= gw) {
				continue;
			}
			let cell = u32(ny) * u32(gw) + u32(nx);
			var j = atomicLoad(&GridHead[cell]);
			loop {
				if (j == INVALID) {
					break;
				}
				let jn = GridNext[j];
				let cur = j;
				j = jn;
				if (cur == i) {
					continue;
				}
				let rv = Particles[cur].pos - pi;
				let r2 = dot(rv, rv);
				if (r2 < 1.0e-12 || r2 >= h2) {
					continue;
				}
				let rr = sqrt(r2);
				let rhat = rv / rr;
				let u = dot(vi - Particles[cur].vel, rhat);
				if (u > 0.0) {
					let q = 1.0 - rr / hr;
					let imp = U[U_DT] * q * sigma * u * 0.5;
					acc = acc - rhat * imp;
				}
			}
		}
	}
	Particles[i].vel2 = vi + acc;
}

// ---------------------------------------------------------------------------
// Advance positions.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_advance(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let p = Particles[i].pos;
	Particles[i].prev = p;
	Particles[i].pos = p + Particles[i].vel2 * U[U_DT];
}

// ---------------------------------------------------------------------------
// Density / near-density / density-gradient normal / pressure (one gather pass).
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_density(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let pi = Particles[i].pos;
	let hr = U[U_HR];
	let h2 = U[U_HR2];
	let gw = i32(U[U_GW]);
	let gh = i32(U[U_GH]);
	let c = cell_coords(pi);
	var density = 0.0;
	var near = 0.0;
	var sum = vec2<f32>(0.0, 0.0);
	var ncount = 0.0;
	var nrm = vec2<f32>(0.0, 0.0);
	for (var dy = -1; dy <= 1; dy = dy + 1) {
		let ny = c.y + dy;
		if (ny < 0 || ny >= gh) {
			continue;
		}
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let nx = c.x + dx;
			if (nx < 0 || nx >= gw) {
				continue;
			}
			let cell = u32(ny) * u32(gw) + u32(nx);
			var j = atomicLoad(&GridHead[cell]);
			loop {
				if (j == INVALID) {
					break;
				}
				let jn = GridNext[j];
				let cur = j;
				j = jn;
				if (cur == i) {
					continue;
				}
				let rv = Particles[cur].pos - pi;
				let r2 = dot(rv, rv);
				if (r2 < 1.0e-12 || r2 >= h2) {
					continue;
				}
				let rr = sqrt(r2);
				let q = 1.0 - rr / hr;
				let q2 = q * q;
				density = density + q2;
				near = near + q2 * q;
				sum = sum + Particles[cur].pos;
				ncount = ncount + 1.0;
				let dw = -2.0 * q / hr;
				nrm = nrm + (rv / rr) * dw;
			}
		}
	}
	let pressure = U[U_STIFF] * (density - U[U_RESTD]);
	let near_pressure = NEAR_K * near;
	let m = length(nrm);
	if (m > 0.08) {
		nrm = nrm / m;
	} else {
		nrm = vec2<f32>(0.0, 0.0);
	}
	Aux[i].dn = vec4<f32>(density, near, pressure, near_pressure);
	Aux[i].nrm = nrm;
	Aux[i].sum = sum;
	Aux[i].cd = vec2<f32>(ncount, 0.0);
	Aux[i].dp = vec2<f32>(0.0, 0.0);
}

// ---------------------------------------------------------------------------
// Pressure / near-pressure displacement (gather).
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_displace(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let pi = Particles[i].pos;
	let hr = U[U_HR];
	let h2 = U[U_HR2];
	let gw = i32(U[U_GW]);
	let gh = i32(U[U_GH]);
	let c = cell_coords(pi);
	let ai = Aux[i].dn;
	let pi_p = ai.z;
	let pi_n = ai.w;
	var dv = vec2<f32>(0.0, 0.0);
	for (var dy = -1; dy <= 1; dy = dy + 1) {
		let ny = c.y + dy;
		if (ny < 0 || ny >= gh) {
			continue;
		}
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let nx = c.x + dx;
			if (nx < 0 || nx >= gw) {
				continue;
			}
			let cell = u32(ny) * u32(gw) + u32(nx);
			var j = atomicLoad(&GridHead[cell]);
			loop {
				if (j == INVALID) {
					break;
				}
				let jn = GridNext[j];
				let cur = j;
				j = jn;
				if (cur == i) {
					continue;
				}
				let rv = Particles[cur].pos - pi;
				let r2 = dot(rv, rv);
				if (r2 < 1.0e-12 || r2 >= h2) {
					continue;
				}
				let rr = sqrt(r2);
				let rhat = rv / rr;
				let q = 1.0 - rr / hr;
				let aj = Aux[cur].dn;
				var d = U[U_DT2] * ((pi_p + pi_n + aj.z + aj.w) * q);
				d = clamp(d, -MAX_DISP, MAX_DISP);
				dv = dv - rhat * (d * 0.5);
			}
		}
	}
	Aux[i].cd.y = dv.x;
	Aux[i].dp.x = dv.y;
}

// ---------------------------------------------------------------------------
// Surface tension: pull surface particles toward their neighbour centroid
// (position-based curvature flow), then accumulate the global mean displacement
// in fixed point so the apply pass can conserve momentum.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_tension(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let alpha = U[U_TENS];
	var dv = vec2<f32>(Aux[i].cd.y, Aux[i].dp.x);
	let nrm = Aux[i].nrm;
	if (alpha > 0.0 && (nrm.x != 0.0 || nrm.y != 0.0)) {
		let ncount = Aux[i].cd.x;
		if (ncount >= 1.0) {
			let centroid = Aux[i].sum / ncount;
			var d = (centroid - Particles[i].pos) * alpha;
			let m = length(d);
			if (m > 0.4) {
				d = d * (0.4 / m);
			}
			dv = dv + d;
		}
	}
	Aux[i].cd.y = dv.x;
	Aux[i].dp.x = dv.y;
	atomicAdd(&Counter[C_MEANX], bitcast<u32>(i32(round(dv.x * MEAN_SCALE))));
	atomicAdd(&Counter[C_MEANY], bitcast<u32>(i32(round(dv.y * MEAN_SCALE))));
}

// ---------------------------------------------------------------------------
// Apply total displacement (mean-subtracted, magnitude-clamped) to positions.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_apply(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let alive = max(f32(atomicLoad(&Counter[C_ALIVE])), 1.0);
	let meanx = f32(bitcast<i32>(atomicLoad(&Counter[C_MEANX]))) / (MEAN_SCALE * alive);
	let meany = f32(bitcast<i32>(atomicLoad(&Counter[C_MEANY]))) / (MEAN_SCALE * alive);
	var dv = vec2<f32>(Aux[i].cd.y, Aux[i].dp.x) - vec2<f32>(meanx, meany);
	let m = length(dv);
	var s = 1.0;
	if (m > MAX_DISP_TOTAL) {
		s = MAX_DISP_TOTAL / m;
	}
	Particles[i].pos = Particles[i].pos + dv * s;
	Aux[i].cd.y = 0.0;
	Aux[i].dp.x = 0.0;
}

// ---------------------------------------------------------------------------
// Wall collision, then re-derive velocity from positions.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_collide(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let margin = U[U_R] * 0.9;
	let p = Particles[i].pos;
	let s = sdf_at(p);
	if (s < margin) {
		let nrm = sdf_normal(p);
		let pen = min(margin - s, 0.6);
		Particles[i].pos = p + nrm * pen;
	}
}

@compute @workgroup_size(64)
fn cs_velocity(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let inv = 1.0 / U[U_DT];
	var v = (Particles[i].pos - Particles[i].prev) * inv;
	let sp2 = dot(v, v);
	if (sp2 > MAX_SPEED * MAX_SPEED) {
		v = v * (MAX_SPEED / sqrt(sp2));
	}
	Particles[i].vel = v;
}

@compute @workgroup_size(64)
fn cs_friction(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let friction = clamp(U[U_STICKY] / 100.0, 0.0, 1.0);
	if (friction <= 0.0) {
		return;
	}
	let p = Particles[i].pos;
	let s = sdf_at(p);
	let reach = U[U_HR] * 0.6;
	if (s >= reach) {
		return;
	}
	let nrm = sdf_normal(p);
	let wgt = clamp(1.0 - max(s, 0.0) / reach, 0.0, 1.0);
	let f = friction * wgt;
	let v = Particles[i].vel;
	let vn = dot(v, nrm);
	let vt = v - nrm * vn;
	var out = vt * (1.0 - f);
	if (vn < 0.0) {
		out = out + nrm * (vn * (1.0 - f));
	}
	Particles[i].vel = out;
}

// ---------------------------------------------------------------------------
// Bulk-translation projection. Wall adhesion + the elastic collision inject net
// momentum at large particle radii, so the whole mass slowly slides and can
// climb a wall. Remove ALL net horizontal velocity and any net *upward* velocity
// each step: the fluid can never drift sideways or levitate, while gravity still
// pulls it down and local motion is untouched.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_vx_sum(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let v = Particles[i].vel;
	atomicAdd(&Counter[C_MVX], bitcast<u32>(i32(round(v.x * MVX_SCALE))));
	atomicAdd(&Counter[C_MVY], bitcast<u32>(i32(round(v.y * MVX_SCALE))));
}

@compute @workgroup_size(64)
fn cs_vx_damp(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let alive = max(f32(atomicLoad(&Counter[C_ALIVE])), 1.0);
	let inv = 1.0 / (MVX_SCALE * alive);
	let mvx = f32(bitcast<i32>(atomicLoad(&Counter[C_MVX]))) * inv;
	let mvy = max(f32(bitcast<i32>(atomicLoad(&Counter[C_MVY]))) * inv, 0.0);
	var v = Particles[i].vel;
	v.x = v.x - mvx;
	v.y = v.y - mvy;
	Particles[i].vel = v;
}

// ---------------------------------------------------------------------------
// Cull (off-grid or tunnelled into a box interior) + free-list recycling.
// ---------------------------------------------------------------------------
fn free_slot(i: u32) {
	Particles[i].alive = 0u;
	let idx = atomicAdd(&Counter[C_FREE], 1u);
	Free[idx] = i;
	atomicSub(&Counter[C_ALIVE], 1u);
}

@compute @workgroup_size(64)
fn cs_cull(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let p = Particles[i].pos;
	let r = U[U_R];
	// Inverted inside-test so non-finite positions are culled too (NaN
	// comparisons are false, so a NaN particle would otherwise never be
	// disposed and would poison every neighbour's density).
	let inGrid = p.x >= -r && p.x <= U[U_W] + r && p.y >= -r && p.y <= U[U_H] + r;
	let gx = i32(floor(p.x));
	let gy = i32(floor(p.y));
	var inside = false;
	if (gx >= 0 && gy >= 0 && gx < i32(U[U_W]) && gy < i32(U[U_H])) {
		inside = Deep[u32(gy) * u32(U[U_W]) + u32(gx)] != 0u;
	}
	if (!inGrid || inside) {
		free_slot(i);
	}
}

// ---------------------------------------------------------------------------
// Emission: rebuild the rest-spacing lattice from live particles, then place
// new particles on free lattice sites that touch existing goo.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_clear_lattice(@builtin(global_invocation_id) g: vec3<u32>) {
	let n = u32(U[U_LGW]) * u32(U[U_LGH]);
	let stride = clear_stride(n);
	var i = g.x;
	loop {
		if (i >= n) {
			break;
		}
		atomicStore(&Lat[i], 0u);
		i = i + stride;
	}
}

@compute @workgroup_size(64)
fn cs_scatter_lattice(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let p = Particles[i].pos;
	let sp = U[U_SP];
	let i0 = i32(round(p.x / sp)) + 1;
	let j0 = i32(round(p.y / sp)) + 1;
	if (i0 >= 0 && j0 >= 0 && i0 < i32(U[U_LGW]) && j0 < i32(U[U_LGH])) {
		atomicStore(&Lat[u32(j0) * u32(U[U_LGW]) + u32(i0)], 1u);
	}
}

fn alloc_slot() -> u32 {
	var slot = INVALID;
	var tries = 0u;
	loop {
		if (tries >= 4u) {
			break;
		}
		tries = tries + 1u;
		let fc = atomicLoad(&Counter[C_FREE]);
		if (fc > 0u) {
			let r = atomicCompareExchangeWeak(&Counter[C_FREE], fc, fc - 1u);
			if (r.exchanged) {
				slot = Free[fc - 1u];
				break;
			}
			continue;
		}
		let t = atomicLoad(&Counter[C_TOP]);
		if (t < u32(U[U_MAXPART])) {
			let r = atomicCompareExchangeWeak(&Counter[C_TOP], t, t + 1u);
			if (r.exchanged) {
				slot = t;
				break;
			}
			continue;
		}
		break;
	}
	return slot;
}

fn spawn_at(p: vec2<f32>) -> bool {
	let slot = alloc_slot();
	if (slot == INVALID) {
		return false;
	}
	atomicAdd(&Counter[C_ALIVE], 1u);
	Particles[slot].pos = p;
	Particles[slot].prev = p;
	Particles[slot].vel = vec2<f32>(0.0, 0.0);
	Particles[slot].vel2 = vec2<f32>(0.0, 0.0);
	Particles[slot].alive = 1u;
	Aux[slot].dn = vec4<f32>(0.0, 0.0, 0.0, 0.0);
	Aux[slot].nrm = vec2<f32>(0.0, 0.0);
	Aux[slot].sum = vec2<f32>(0.0, 0.0);
	Aux[slot].cd = vec2<f32>(0.0, 0.0);
	Aux[slot].dp = vec2<f32>(0.0, 0.0);
	return true;
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(global_invocation_id) g: vec3<u32>) {
	let gid = g.x;
	if (gid >= atomicLoad(&Counter[C_SPAWN])) {
		return;
	}
	let n = u32(U[U_EMITN]);
	if (n == 0u) {
		return;
	}
	let sp = U[U_SP];
	let off = U[U_OFF];
	let lgw = i32(U[U_LGW]);
	let lgh = i32(U[U_LGH]);
	var seed = pcg(gid * 2654435761u + u32(U[U_TICK]) * 40503u);
	var placed = false;
	var attempt = 0u;
	loop {
		if (attempt >= EMIT_TRIES || placed) {
			break;
		}
		attempt = attempt + 1u;
		seed = pcg(seed);
		let pick = seed % n;
		let e = Emit[pick];
		let bi = i32(round((e.x + e.z * off) / sp)) + 1;
		let bj = i32(round((e.y + e.w * off) / sp)) + 1;
		var bestCi = -1;
		var bestD2 = 0x7fffffff;
		var anyGoo = false;
		for (var dj = -EMIT_SEARCH; dj <= EMIT_SEARCH; dj = dj + 1) {
			for (var di = -EMIT_SEARCH; di <= EMIT_SEARCH; di = di + 1) {
				let i = bi + di;
				let j = bj + dj;
				if (i < 1 || j < 1 || i >= lgw - 1 || j >= lgh - 1) {
					continue;
				}
				let ci = j * lgw + i;
				if (atomicLoad(&Lat[u32(ci)]) != 0u) {
					anyGoo = true;
					continue;
				}
				var attached = false;
				for (var ndj = -1; ndj <= 1; ndj = ndj + 1) {
					for (var ndi = -1; ndi <= 1; ndi = ndi + 1) {
						if (ndi == 0 && ndj == 0) {
							continue;
						}
						if (atomicLoad(&Lat[u32((j + ndj) * lgw + (i + ndi))]) != 0u) {
							attached = true;
						}
					}
				}
				if (!attached) {
					continue;
				}
				let d2 = di * di + dj * dj;
				if (d2 < bestD2) {
					bestD2 = d2;
					bestCi = ci;
				}
			}
		}
		var site = -1; // lattice index (ci)
		if (bestCi >= 0) {
			let r = atomicCompareExchangeWeak(&Lat[u32(bestCi)], 0u, 1u);
			if (r.exchanged) {
				site = bestCi;
			}
		} else if (!anyGoo && bi >= 1 && bj >= 1 && bi < lgw - 1 && bj < lgh - 1) {
			let ci = bj * lgw + bi;
			let r = atomicCompareExchangeWeak(&Lat[u32(ci)], 0u, 1u);
			if (r.exchanged) {
				site = ci;
			}
		}
		if (site >= 0) {
			let li = site % lgw;
			let lj = site / lgw;
			placed = spawn_at(vec2<f32>(f32(li - 1) * sp, f32(lj - 1) * sp));
		}
	}
}

// ---------------------------------------------------------------------------
// Metaball density field (fixed-point atomic accumulation) + full clear.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn cs_clear_field(@builtin(global_invocation_id) g: vec3<u32>) {
	let n = u32(U[U_W]) * u32(U[U_H]);
	let stride = clear_stride(n);
	var i = g.x;
	loop {
		if (i >= n) {
			break;
		}
		atomicStore(&Field[i], 0u);
		i = i + stride;
	}
}

@compute @workgroup_size(64)
fn cs_splat(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x;
	if (i >= u32(U[U_MAXPART]) || !is_alive(i)) {
		return;
	}
	let p = Particles[i].pos;
	let blob = U[U_BLOB];
	let w = i32(U[U_W]);
	let h = i32(U[U_H]);
	let cx0 = max(i32(floor(p.x - blob)), 0);
	let cy0 = max(i32(floor(p.y - blob)), 0);
	let cx1 = min(i32(ceil(p.x + blob)), w);
	let cy1 = min(i32(ceil(p.y + blob)), h);
	let r2 = blob * blob;
	for (var gy = cy0; gy < cy1; gy = gy + 1) {
		let dy = f32(gy) + 0.5 - p.y;
		let row = u32(gy) * u32(U[U_W]);
		for (var gx = cx0; gx < cx1; gx = gx + 1) {
			let dx = f32(gx) + 0.5 - p.x;
			let d2 = dx * dx + dy * dy;
			if (d2 >= r2) {
				continue;
			}
			let t = 1.0 - d2 / r2;
			atomicAdd(&Field[row + u32(gx)], u32(t * t * t * U[U_SPLAT]));
		}
	}
}
