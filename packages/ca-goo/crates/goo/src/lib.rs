//! Goo: substrate-emitted position-based (PBD) fluid compiled to wasm32.
//!
//! This is a hand-rolled Clavet-style particle fluid ("Particle-based
//! Viscoelastic Fluid Simulation", Clavet et al. 2005) rather than salva's SPH.
//! SPH surface tension is a force layered on an incompressible pressure solve,
//! so it is weak at this particle size and explodes when strong, and a narrow
//! gap squirts fluid out like a cannon. A position-based solver relaxes density
//! by moving particles, so cohesion and viscosity can be cranked arbitrarily
//! without blowing up and confined gaps stay calm. That gives the droopy,
//! hanging goo that necks and drips.
//!
//! ABI (all extern "C", no wasm-bindgen): the caller reserves an input buffer,
//! copies the substrate mask into it, then creates a sim. `goo_tick` returns a
//! pointer to `[x, y, w, h, ...rgba]` (f32) or 0 when there is no patch.

use std::cell::RefCell;

/// Interaction radius in units of particle_radius.
const SMOOTHING: f32 = 3.0;
/// Thickness (in cells) of the substrate shell used for the deep-interior mask.
const SHELL: i32 = 5;
/// Fluid particle rest spacing in units of particle_radius (= sqrt(4 * 0.8)).
const REST_SPACING: f32 = 1.788_854_4;
/// Produce/upload a density patch every N sim ticks (the sim still steps each tick).
const PATCH_EVERY: u32 = 3;
/// Cap on per-pair position displacement (cells) so a stiff setting can't explode.
const MAX_DISP: f32 = 0.35;
/// Cap on a particle's total displacement per step (cells) — bounds derived velocity.
const MAX_DISP_TOTAL: f32 = 0.12;
/// Hard speed cap (cells/s). Prevents confined goo from being "fired" out of gaps.
const MAX_SPEED: f32 = 55.0;
/// Near-density (anti-clustering) coefficient. Small: cohesion is the attractive
/// force; this only stops particles from stacking into a lattice.
const NEAR_K: f32 = 0.3;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Reserve the shared input buffer and return its pointer. The caller copies
/// `w * h` substrate bytes there before calling `goo_new`.
#[no_mangle]
pub extern "C" fn goo_input_reserve(n: usize) -> *mut u8 {
    INPUT.with(|cell| {
        let mut buf = cell.borrow_mut();
        buf.clear();
        buf.resize(n, 0);
        buf.as_mut_ptr()
    })
}

/// Two-pass chamfer distance transform: `sources[i] != 0` seeds distance 0.
fn chamfer(w: usize, h: usize, sources: &[u8]) -> Vec<f32> {
    let inf = 1.0e9f32;
    let diag = std::f32::consts::SQRT_2;
    let mut d = vec![inf; w * h];
    for i in 0..w * h {
        if sources[i] != 0 {
            d[i] = 0.0;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut v = d[i];
            if x > 0 {
                v = v.min(d[i - 1] + 1.0);
            }
            if y > 0 {
                v = v.min(d[i - w] + 1.0);
            }
            if x > 0 && y > 0 {
                v = v.min(d[i - w - 1] + diag);
            }
            if x + 1 < w && y > 0 {
                v = v.min(d[i - w + 1] + diag);
            }
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut v = d[i];
            if x + 1 < w {
                v = v.min(d[i + 1] + 1.0);
            }
            if y + 1 < h {
                v = v.min(d[i + w] + 1.0);
            }
            if x + 1 < w && y + 1 < h {
                v = v.min(d[i + w + 1] + diag);
            }
            if x > 0 && y + 1 < h {
                v = v.min(d[i + w - 1] + diag);
            }
            d[i] = v;
        }
    }
    d
}

pub struct GooSim {
    w: usize,
    h: usize,
    substrate: Vec<u8>,
    /// 1 for substrate cells far from any free cell (box interiors); goo that ends
    /// up here has tunnelled through a wall and is culled.
    deep: Vec<u8>,
    /// Signed distance to the substrate surface (positive in free space).
    sdf: Vec<f32>,
    h_radius: f32,
    emitters: Vec<(f32, f32, f32, f32)>,

    pos: Vec<[f32; 2]>,
    vel: Vec<[f32; 2]>,
    prev_pos: Vec<[f32; 2]>,
    density: Vec<f32>,
    near_density: Vec<f32>,
    pressure: Vec<f32>,
    near_pressure: Vec<f32>,
    disp: Vec<[f32; 2]>,
    normal: Vec<[f32; 2]>,
    nsum: Vec<[f32; 2]>,
    ncount: Vec<f32>,
    curv: Vec<f32>,

    // Uniform spatial grid (counting sort).
    gw: usize,
    gh: usize,
    grid_counts: Vec<u32>,
    grid_starts: Vec<u32>,
    grid_cursor: Vec<u32>,
    grid_order: Vec<u32>,

    // Render / patch.
    field: Vec<f32>,
    patch: Vec<f32>,
    pos_out: Vec<f32>,
    locc: Vec<u8>,
    pending: Option<(i32, i32, i32, i32)>,
    tick_count: u32,
    pair_count: f32,

    max_particles: usize,
    emit_accum: f32,
    rng: u32,
    r: f32,

    // Live params (updated through `goo_set`).
    emit: f32,
    gravity: f32,
    viscosity: f32,
    stiffness: f32,
    tension: f32,
    sticky: f32,
    blob: f32,
    rest_density: f32,
}

impl GooSim {
    fn new(w: usize, h: usize, substrate: Vec<u8>, r: f32, max_particles: usize) -> Self {
        // Deep-interior mask (substrate cells with no free cell within SHELL).
        let mut deep = vec![0u8; w * h];
        for gy in 0..h as i32 {
            for gx in 0..w as i32 {
                let i = gy as usize * w + gx as usize;
                if substrate[i] == 0 {
                    continue;
                }
                let mut near_free = false;
                'd: for dy in -SHELL..=SHELL {
                    for dx in -SHELL..=SHELL {
                        let nx = gx + dx;
                        let ny = gy + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        if substrate[(ny as usize) * w + nx as usize] == 0 {
                            near_free = true;
                            break 'd;
                        }
                    }
                }
                if !near_free {
                    deep[i] = 1;
                }
            }
        }

        // Signed distance to the substrate surface.
        let free: Vec<u8> = substrate.iter().map(|&s| if s == 0 { 1 } else { 0 }).collect();
        let d_sub = chamfer(w, h, &substrate);
        let d_free = chamfer(w, h, &free);
        let mut sdf = vec![0.0f32; w * h];
        for i in 0..w * h {
            sdf[i] = if substrate[i] == 0 { d_sub[i] } else { -d_free[i] };
        }

        // Emitters: free cells touching the substrate, with an outward normal.
        let mut emitters: Vec<(f32, f32, f32, f32)> = Vec::new();
        for gy in 0..h as i32 {
            for gx in 0..w as i32 {
                if substrate[(gy as usize) * w + gx as usize] != 0 {
                    continue;
                }
                let (ex, ey) = (gx as f32 + 0.5, gy as f32 + 0.5);
                let mut nx = 0.0;
                let mut ny = 0.0;
                let mut touching = false;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let sx = gx + dx;
                        let sy = gy + dy;
                        if sx < 0 || sy < 0 || sx >= w as i32 || sy >= h as i32 {
                            continue;
                        }
                        if substrate[(sy as usize) * w + sx as usize] != 0 {
                            touching = true;
                            nx += ex - (sx as f32 + 0.5);
                            ny += ey - (sy as f32 + 0.5);
                        }
                    }
                }
                if !touching {
                    continue;
                }
                let len = (nx * nx + ny * ny).sqrt().max(1.0e-4);
                emitters.push((ex, ey, nx / len, ny / len));
            }
        }

        let h_radius = r * SMOOTHING;
        let gw = (w as f32 / h_radius).ceil() as usize + 2;
        let gh = (h as f32 / h_radius).ceil() as usize + 2;
        let ngrid = gw * gh;

        GooSim {
            w,
            h,
            substrate,
            deep,
            sdf,
            h_radius,
            emitters,
            pos: Vec::new(),
            vel: Vec::new(),
            prev_pos: Vec::new(),
            density: Vec::new(),
            near_density: Vec::new(),
            pressure: Vec::new(),
            near_pressure: Vec::new(),
            disp: Vec::new(),
            normal: Vec::new(),
            nsum: Vec::new(),
            ncount: Vec::new(),
            curv: Vec::new(),
            gw,
            gh,
            grid_counts: vec![0; ngrid],
            grid_starts: vec![0; ngrid],
            grid_cursor: vec![0; ngrid],
            grid_order: Vec::new(),
            field: vec![0.0; w * h],
            patch: Vec::new(),
            pos_out: Vec::new(),
            locc: Vec::new(),
            pending: None,
            tick_count: 0,
            pair_count: 0.0,
            max_particles,
            emit_accum: 0.0,
            rng: 0x9e3779b9,
            r,
            emit: 300.0,
            gravity: 20.0,
            viscosity: 0.5,
            stiffness: 60.0,
            tension: 0.04,
            sticky: 60.0,
            blob: 3.8,
            rest_density: 0.75,
        }
    }

    #[inline]
    fn rnd(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1u32 << 24) as f32
    }

    #[inline]
    fn cell_of(&self, p: [f32; 2]) -> usize {
        let cx = ((p[0] / self.h_radius).floor() as i32).clamp(0, self.gw as i32 - 1);
        let cy = ((p[1] / self.h_radius).floor() as i32).clamp(0, self.gh as i32 - 1);
        cy as usize * self.gw + cx as usize
    }

    fn build_grid(&mut self) {
        for c in self.grid_counts.iter_mut() {
            *c = 0;
        }
        let n = self.pos.len();
        self.grid_order.resize(n, 0);
        for i in 0..n {
            let c = self.cell_of(self.pos[i]);
            self.grid_counts[c] += 1;
        }
        let mut sum = 0u32;
        for c in 0..self.grid_counts.len() {
            self.grid_starts[c] = sum;
            sum += self.grid_counts[c];
        }
        self.grid_cursor.copy_from_slice(&self.grid_starts);
        for i in 0..n {
            let c = self.cell_of(self.pos[i]);
            let at = self.grid_cursor[c] as usize;
            self.grid_order[at] = i as u32;
            self.grid_cursor[c] += 1;
        }
    }

    #[inline]
    fn sdf_at(&self, p: [f32; 2]) -> f32 {
        let cx = (p[0].floor() as i32).clamp(0, self.w as i32 - 1) as usize;
        let cy = (p[1].floor() as i32).clamp(0, self.h as i32 - 1) as usize;
        self.sdf[cy * self.w + cx]
    }

    /// Outward unit normal of the substrate surface at a position.
    #[inline]
    fn sdf_normal(&self, p: [f32; 2]) -> [f32; 2] {
        let gx = self.sdf_at([p[0] + 1.0, p[1]]) - self.sdf_at([p[0] - 1.0, p[1]]);
        let gy = self.sdf_at([p[0], p[1] + 1.0]) - self.sdf_at([p[0], p[1] - 1.0]);
        let l = (gx * gx + gy * gy).sqrt();
        if l < 1.0e-5 {
            [0.0, 1.0]
        } else {
            [gx / l, gy / l]
        }
    }

    fn emit_particles(&mut self, dt: f32) {
        if self.emitters.is_empty() {
            return;
        }
        let w = self.w;
        let h = self.h;
        let n = self.pos.len();
        if n >= self.max_particles {
            return;
        }

        // Goo is emitted onto a global lattice at the fluid rest spacing, so new
        // particles never overlap existing ones (overlap is what a particle fluid
        // hates most).
        let sp = self.r * REST_SPACING;
        let gw = (w as f32 / sp).ceil() as usize + 2;
        let gh = (h as f32 / sp).ceil() as usize + 2;
        self.locc.clear();
        self.locc.resize(gw * gh, 0);
        for p in &self.pos {
            let i = (p[0] / sp).round() as i32 + 1;
            let j = (p[1] / sp).round() as i32 + 1;
            if i >= 0 && j >= 0 && (i as usize) < gw && (j as usize) < gh {
                self.locc[j as usize * gw + i as usize] = 1;
            }
        }

        self.emit_accum += self.emit * dt;
        let off = self.r * 1.2;
        let mut spawn: Vec<[f32; 2]> = Vec::new();
        while self.emit_accum >= 1.0 && n + spawn.len() < self.max_particles {
            self.emit_accum -= 1.0;
            let len = self.emitters.len();
            for _ in 0..12 {
                let r0 = self.rnd();
                let pick = (r0 * len as f32) as usize % len;
                let (ex, ey, nx, ny) = self.emitters[pick];
                let bi = ((ex + nx * off) / sp).round() as i32 + 1;
                let bj = ((ey + ny * off) / sp).round() as i32 + 1;

                // Prefer a free lattice site that touches existing goo, so new
                // emission merges into the blob instead of appearing as an isolated
                // particle (which has no cohesion and just falls away). If no goo is
                // near the emitter, seed a single particle instead.
                let mut best: Option<(usize, i32)> = None;
                let mut any_goo = false;
                for dj in -3..=3 {
                    for di in -3..=3 {
                        let i = bi + di;
                        let j = bj + dj;
                        if i < 1 || j < 1 || i as usize >= gw - 1 || j as usize >= gh - 1 {
                            continue;
                        }
                        let ci = j as usize * gw + i as usize;
                        if self.locc[ci] != 0 {
                            any_goo = true;
                            continue;
                        }
                        let mut attached = false;
                        'nb: for ndj in -1..=1 {
                            for ndi in -1..=1 {
                                if ndi == 0 && ndj == 0 {
                                    continue;
                                }
                                if self.locc[(j + ndj) as usize * gw + (i + ndi) as usize] != 0 {
                                    attached = true;
                                    break 'nb;
                                }
                            }
                        }
                        if !attached {
                            continue;
                        }
                        let d2 = di * di + dj * dj;
                        if best.map_or(true, |(_, bd)| d2 < bd) {
                            best = Some((ci, d2));
                        }
                    }
                }
                if let Some((ci, _)) = best {
                    self.locc[ci] = 1;
                    let i = ci % gw;
                    let j = ci / gw;
                    spawn.push([(i - 1) as f32 * sp, (j - 1) as f32 * sp]);
                    break;
                }
                if !any_goo
                    && bi >= 1
                    && bj >= 1
                    && (bi as usize) < gw - 1
                    && (bj as usize) < gh - 1
                {
                    let ci = bj as usize * gw + bi as usize;
                    if self.locc[ci] == 0 {
                        self.locc[ci] = 1;
                        spawn.push([(bi - 1) as f32 * sp, (bj - 1) as f32 * sp]);
                        break;
                    }
                }
            }
        }
        if spawn.is_empty() {
            return;
        }
        for p in &spawn {
            self.pos.push(*p);
            self.vel.push([0.0, 0.0]);
            self.prev_pos.push(*p);
            self.density.push(0.0);
            self.near_density.push(0.0);
            self.pressure.push(0.0);
            self.near_pressure.push(0.0);
            self.disp.push([0.0, 0.0]);
            self.normal.push([0.0, 0.0]);
            self.nsum.push([0.0, 0.0]);
            self.ncount.push(0.0);
            self.curv.push(0.0);
        }
    }

    fn collide(&mut self) {
        let margin = self.r * 0.9;
        for i in 0..self.pos.len() {
            let p = self.pos[i];
            let s = self.sdf_at(p);
            if s < margin {
                let nrm = self.sdf_normal(p);
                let pen = (margin - s).min(0.6);
                self.pos[i][0] += nrm[0] * pen;
                self.pos[i][1] += nrm[1] * pen;
            }
        }
    }

    /// Damp velocity near walls (stickiness): resist sliding and bouncing.
    fn wall_friction(&mut self) {
        let friction = (self.sticky / 100.0).clamp(0.0, 1.0);
        if friction <= 0.0 {
            return;
        }
        let reach = self.h_radius * 0.6;
        for i in 0..self.pos.len() {
            let p = self.pos[i];
            let s = self.sdf_at(p);
            if s >= reach {
                continue;
            }
            let nrm = self.sdf_normal(p);
            let wgt = (1.0 - (s / reach).max(0.0)).clamp(0.0, 1.0);
            let f = friction * wgt;
            let v = self.vel[i];
            let vn = v[0] * nrm[0] + v[1] * nrm[1];
            let vt = [v[0] - nrm[0] * vn, v[1] - nrm[1] * vn];
            // Remove most tangential motion and damp the normal component.
            self.vel[i] = [vt[0] * (1.0 - f), vt[1] * (1.0 - f)];
            if vn < 0.0 {
                self.vel[i][0] += nrm[0] * vn * (1.0 - f);
                self.vel[i][1] += nrm[1] * vn * (1.0 - f);
            }
        }
    }

    /// Curvature-based (CSF) surface tension: `F = sigma * kappa * n`.
    /// Computes a per-particle interface normal from the density gradient and a
    /// curvature from how the normals diverge, then pushes along the normal. This
    /// is real surface tension (Laplace pressure): ~0 on a flat surface, strong
    /// where the interface bends, so it necks hanging blobs and resists a stream
    /// being shot out of a gap. (The rest density only compresses the bulk and the
    /// near-density term only spreads the surface -- neither is surface tension.)

    /// Surface-area minimisation applied as a position displacement: pull surface
    /// particles toward their neighbour centroid (Laplacian / curvature flow).
    /// Dissipative, so it is stable, unlike a velocity curvature force.
    fn surface_tension_displace(&mut self) {
        let alpha = self.tension;
        if alpha <= 0.0 {
            return;
        }
        let n = self.pos.len();
        let mut total = [0.0f32, 0.0f32];
        for i in 0..n {
            if self.normal[i][0] == 0.0 && self.normal[i][1] == 0.0 {
                continue;
            }
            let c = self.ncount[i];
            if c < 1.0 {
                continue;
            }
            let mut dx = (self.nsum[i][0] / c - self.pos[i][0]) * alpha;
            let mut dy = (self.nsum[i][1] / c - self.pos[i][1]) * alpha;
            let m = (dx * dx + dy * dy).sqrt();
            if m > 0.4 {
                dx *= 0.4 / m;
                dy *= 0.4 / m;
            }
            self.disp[i][0] += dx;
            self.disp[i][1] += dy;
            total[0] += dx;
            total[1] += dy;
        }
        // Subtract the mean displacement from every particle so the surface-tension
        // step conserves momentum. Without this the inward pulls are one-sided
        // (surface particles pulled in, interior not pushed back), so the net
        // impulse slowed whole clusters -- balls fell far slower than loose drops.
        if n > 0 {
            let mx = total[0] / n as f32;
            let my = total[1] / n as f32;
            if mx != 0.0 || my != 0.0 {
                for i in 0..n {
                    self.disp[i][0] -= mx;
                    self.disp[i][1] -= my;
                }
            }
        }
    }

    fn step(&mut self, dt: f32) {
        let n = self.pos.len();
        if n == 0 {
            return;
        }
        let h = self.h_radius;
        let h2 = h * h;
        let gw = self.gw;
        let gh = self.gh;

        // 1. External forces: gravity + wall adhesion.
        for i in 0..n {
            self.vel[i][1] -= self.gravity * dt;
        }
        let adhesion = (self.sticky / 100.0) * 60.0;
        if adhesion > 0.0 {
            // Rest-distance adhesion (see goo.wgsl): zero at the resting gap
            // (r*0.9, the collision margin), rising with separation. A pull that
            // peaks at the wall pumps particles into it and collision bounces
            // them back out, which makes large-radius goo self-propel.
            let reach = self.h_radius * 0.7;
            let rest = self.r * 0.9;
            for i in 0..n {
                let p = self.pos[i];
                let s = self.sdf_at(p);
                if s <= rest || s >= reach {
                    continue;
                }
                let nrm = self.sdf_normal(p);
                let wgt = 1.0 - (s - rest) / (reach - rest);
                let a = adhesion * wgt * dt;
                self.vel[i][0] -= nrm[0] * a;
                self.vel[i][1] -= nrm[1] * a;
            }
        }

        self.build_grid();

        // 2. Viscosity (explicit, on velocities).
        // 3. Viscosity (explicit, on velocities).
        if self.viscosity > 0.0 {
            let sigma = self.viscosity;
            for i in 0..n {
                let pi = self.pos[i];
                let cx = ((pi[0] / h).floor() as i32).clamp(0, gw as i32 - 1);
                let cy = ((pi[1] / h).floor() as i32).clamp(0, gh as i32 - 1);
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let nx = cx + dx;
                        let ny = cy + dy;
                        if nx < 0 || ny < 0 || nx >= gw as i32 || ny >= gh as i32 {
                            continue;
                        }
                        let cc = ny as usize * gw + nx as usize;
                        let s = self.grid_starts[cc] as usize;
                        let e = s + self.grid_counts[cc] as usize;
                        for kk in s..e {
                            let j = self.grid_order[kk] as usize;
                            if j <= i {
                                continue;
                            }
                            let rv = [self.pos[j][0] - pi[0], self.pos[j][1] - pi[1]];
                            let r2 = rv[0] * rv[0] + rv[1] * rv[1];
                            if r2 < 1.0e-12 || r2 >= h2 {
                                continue;
                            }
                            let rr = r2.sqrt();
                            let rhat = [rv[0] / rr, rv[1] / rr];
                            let u = (self.vel[i][0] - self.vel[j][0]) * rhat[0]
                                + (self.vel[i][1] - self.vel[j][1]) * rhat[1];
                            if u > 0.0 {
                                let q = 1.0 - rr / h;
                                let imp = dt * q * sigma * u * 0.5;
                                self.vel[i][0] -= rhat[0] * imp;
                                self.vel[i][1] -= rhat[1] * imp;
                                self.vel[j][0] += rhat[0] * imp;
                                self.vel[j][1] += rhat[1] * imp;
                            }
                        }
                    }
                }
            }
        }



        // 2. Advance positions.
        for i in 0..n {
            self.prev_pos[i] = self.pos[i];
            self.pos[i][0] += self.vel[i][0] * dt;
            self.pos[i][1] += self.vel[i][1] * dt;
        }

        self.build_grid();

        // 4. Double-density relaxation.
        for i in 0..n {
            self.density[i] = 0.0;
            self.near_density[i] = 0.0;
            self.nsum[i] = [0.0, 0.0];
            self.ncount[i] = 0.0;
            self.normal[i] = [0.0, 0.0];
        }
        self.pair_count = 0.0;
        for i in 0..n {
            let pi = self.pos[i];
            let cx = ((pi[0] / h).floor() as i32).clamp(0, gw as i32 - 1);
            let cy = ((pi[1] / h).floor() as i32).clamp(0, gh as i32 - 1);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let nx = cx + dx;
                    let ny = cy + dy;
                    if nx < 0 || ny < 0 || nx >= gw as i32 || ny >= gh as i32 {
                        continue;
                    }
                    let cc = ny as usize * gw + nx as usize;
                    let s = self.grid_starts[cc] as usize;
                    let e = s + self.grid_counts[cc] as usize;
                    for kk in s..e {
                        let j = self.grid_order[kk] as usize;
                        if j <= i {
                            continue;
                        }
                        let rv = [self.pos[j][0] - pi[0], self.pos[j][1] - pi[1]];
                        let r2 = rv[0] * rv[0] + rv[1] * rv[1];
                        if r2 >= h2 || r2 < 1.0e-12 {
                            continue;
                        }
                        let rr = r2.sqrt();
                        let q = 1.0 - rr / h;
                        let q2 = q * q;
                        self.density[i] += q2;
                        self.density[j] += q2;
                        self.near_density[i] += q2 * q;
                        self.near_density[j] += q2 * q;
                        self.nsum[i][0] += self.pos[j][0];
                        self.nsum[i][1] += self.pos[j][1];
                        self.ncount[i] += 1.0;
                        self.nsum[j][0] += pi[0];
                        self.nsum[j][1] += pi[1];
                        self.ncount[j] += 1.0;
                        self.pair_count += 1.0;
                        // density-gradient normal (same pass as density)
                        let dw = -2.0 * q / h;
                        let gx = rv[0] / rr * dw;
                        let gy = rv[1] / rr * dw;
                        self.normal[i][0] += gx;
                        self.normal[i][1] += gy;
                        self.normal[j][0] -= gx;
                        self.normal[j][1] -= gy;
                    }
                }
            }
        }
        for i in 0..n {
            self.pressure[i] = self.stiffness * (self.density[i] - self.rest_density);
            self.near_pressure[i] = NEAR_K * self.near_density[i];
            // Surface particles (strong density gradient) get the cohesion pull.
            // Computed in the same pass as the density -- no extra pair pass.
            let m = (self.normal[i][0] * self.normal[i][0]
                + self.normal[i][1] * self.normal[i][1])
                .sqrt();
            self.normal[i] = if m > 0.08 {
                [self.normal[i][0] / m, self.normal[i][1] / m]
            } else {
                [0.0, 0.0]
            };
        }

        // 5. Apply displacements (position-based). Cohesion/surface tension is the
        // rest density: above the packing density every particle has negative
        // pressure, so the pressure term pulls the fluid together (stable, unlike a
        // separate attractive force which oscillates against the pressure).
        let dt2 = dt * dt;
        for i in 0..n {
            let pi = self.pos[i];
            let cx = ((pi[0] / h).floor() as i32).clamp(0, gw as i32 - 1);
            let cy = ((pi[1] / h).floor() as i32).clamp(0, gh as i32 - 1);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let nx = cx + dx;
                    let ny = cy + dy;
                    if nx < 0 || ny < 0 || nx >= gw as i32 || ny >= gh as i32 {
                        continue;
                    }
                    let cc = ny as usize * gw + nx as usize;
                    let s = self.grid_starts[cc] as usize;
                    let e = s + self.grid_counts[cc] as usize;
                    for kk in s..e {
                        let j = self.grid_order[kk] as usize;
                        if j <= i {
                            continue;
                        }
                        let rv = [self.pos[j][0] - pi[0], self.pos[j][1] - pi[1]];
                        let r2 = rv[0] * rv[0] + rv[1] * rv[1];
                        if r2 < 1.0e-12 || r2 >= h2 {
                            continue;
                        }
                        let rr = r2.sqrt();
                        let rhat = [rv[0] / rr, rv[1] / rr];
                        let q = 1.0 - rr / h;
                        let mut d = dt2
                            * (self.pressure[i] * q
                                + self.pressure[j] * q
                                + self.near_pressure[i] * q
                                + self.near_pressure[j] * q);
                        d = d.clamp(-MAX_DISP, MAX_DISP);
                        self.disp[i][0] -= rhat[0] * d * 0.5;
                        self.disp[i][1] -= rhat[1] * d * 0.5;
                        self.disp[j][0] += rhat[0] * d * 0.5;
                        self.disp[j][1] += rhat[1] * d * 0.5;
                    }
                }
            }
        }

        self.surface_tension_displace();

        // Clamp each particle's *total* displacement, then apply. Without this the
        // per-pair caps sum over ~15 neighbours into a large move, and the derived
        // velocity (dx/dt) becomes huge — that is the "cannon".
        for i in 0..n {
            let dx = self.disp[i][0];
            let dy = self.disp[i][1];
            let m = (dx * dx + dy * dy).sqrt();
            let s = if m > MAX_DISP_TOTAL { MAX_DISP_TOTAL / m } else { 1.0 };
            self.pos[i][0] += dx * s;
            self.pos[i][1] += dy * s;
            self.disp[i] = [0.0, 0.0];
        }

        // 6. Collide with walls, then derive velocities from positions.
        self.collide();
        let inv = 1.0 / dt;
        for i in 0..n {
            let mut vx = (self.pos[i][0] - self.prev_pos[i][0]) * inv;
            let mut vy = (self.pos[i][1] - self.prev_pos[i][1]) * inv;
            let sp2 = vx * vx + vy * vy;
            if sp2 > MAX_SPEED * MAX_SPEED {
                let s = MAX_SPEED / sp2.sqrt();
                vx *= s;
                vy *= s;
            }
            self.vel[i][0] = vx;
            self.vel[i][1] = vy;
        }
        self.wall_friction();

        // Project out bulk translation. Wall adhesion + the elastic collision
        // inject net momentum at large particle radii, so the whole mass slowly
        // slides and can climb a wall. Remove ALL net horizontal velocity and any
        // net *upward* velocity each step: the fluid can never drift sideways or
        // levitate, but gravity still pulls it down and local motion is untouched.
        let mut mvx = 0.0f32;
        let mut mvy = 0.0f32;
        for i in 0..n {
            mvx += self.vel[i][0];
            mvy += self.vel[i][1];
        }
        let invn = 1.0 / n as f32;
        let rvx = mvx * invn;
        let rvy = (mvy * invn).max(0.0);
        if rvx != 0.0 || rvy != 0.0 {
            for i in 0..n {
                self.vel[i][0] -= rvx;
                self.vel[i][1] -= rvy;
            }
        }
    }

    fn cull(&mut self) {
        let (w, h, r) = (self.w, self.h, self.r);
        let mut dead: Vec<(usize, f32, f32)> = Vec::new();
        for i in 0..self.pos.len() {
            let p = self.pos[i];
            // Inverted inside-test so non-finite positions are culled too.
            let in_grid = p[0] >= -r
                && p[0] <= w as f32 + r
                && p[1] >= -r
                && p[1] <= h as f32 + r;
            let gx = p[0].floor() as i32;
            let gy = p[1].floor() as i32;
            let inside = gx >= 0
                && gy >= 0
                && gx < w as i32
                && gy < h as i32
                && self.deep[(gy as usize) * w + gx as usize] != 0;
            if !in_grid || inside {
                dead.push((i, p[0], p[1]));
            }
        }
        for &(_, x, y) in &dead {
            let b = self.splat_bbox(x, y, self.blob);
            self.union_pending(b);
        }
        // Remove in descending index order.
        dead.sort_by(|a, b| b.0.cmp(&a.0));
        for &(i, _, _) in &dead {
            let last = self.pos.len() - 1;
            self.pos.swap(i, last);
            self.pos.pop();
            self.vel.swap(i, last);
            self.vel.pop();
            self.prev_pos.swap(i, last);
            self.prev_pos.pop();
            self.density.swap(i, last);
            self.density.pop();
            self.near_density.swap(i, last);
            self.near_density.pop();
            self.pressure.swap(i, last);
            self.pressure.pop();
            self.near_pressure.swap(i, last);
            self.near_pressure.pop();
            self.disp.swap(i, last);
            self.disp.pop();
            self.normal.swap(i, last);
            self.normal.pop();
            self.nsum.swap(i, last);
            self.nsum.pop();
            self.ncount.swap(i, last);
            self.ncount.pop();
            self.curv.swap(i, last);
            self.curv.pop();
        }
    }

    /// Cell bbox a particle splats into, clipped to the grid.
    fn splat_bbox(&self, px: f32, py: f32, blob: f32) -> (i32, i32, i32, i32) {
        (
            (px - blob).floor().max(0.0) as i32,
            (py - blob).floor().max(0.0) as i32,
            (px + blob).ceil().min(self.w as f32) as i32,
            (py + blob).ceil().min(self.h as f32) as i32,
        )
    }

    fn union_pending(&mut self, b: (i32, i32, i32, i32)) {
        if b.2 <= b.0 || b.3 <= b.1 {
            return;
        }
        self.pending = Some(match self.pending {
            Some(a) => (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)),
            None => b,
        });
    }

    fn build_patch(&mut self) {
        let (w, blob) = (self.w, self.blob);
        if !self.pos.is_empty() {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for p in &self.pos {
                x0 = x0.min(p[0]);
                y0 = y0.min(p[1]);
                x1 = x1.max(p[0]);
                y1 = y1.max(p[1]);
            }
            let a = self.splat_bbox(x0, y0, blob);
            let b = self.splat_bbox(x1, y1, blob);
            self.union_pending((a.0, a.1, b.2, b.3));
        }

        let (bx0, by0, bx1, by1) = match self.pending {
            Some(b) if b.2 > b.0 && b.3 > b.1 => b,
            _ => {
                self.patch.clear();
                self.pending = None;
                return;
            }
        };
        let pw = (bx1 - bx0) as usize;
        let ph = (by1 - by0) as usize;

        for gy in by0..by1 {
            let row = gy as usize * w;
            for gx in bx0..bx1 {
                self.field[row + gx as usize] = 0.0;
            }
        }
        let r2 = blob * blob;
        for p in &self.pos {
            let cx0 = (p[0] - blob).floor().max(bx0 as f32) as i32;
            let cy0 = (p[1] - blob).floor().max(by0 as f32) as i32;
            let cx1 = (p[0] + blob).ceil().min(bx1 as f32) as i32;
            let cy1 = (p[1] + blob).ceil().min(by1 as f32) as i32;
            for gy in cy0..cy1 {
                let row = gy as usize * w;
                let dy = gy as f32 + 0.5 - p[1];
                for gx in cx0..cx1 {
                    let dx = gx as f32 + 0.5 - p[0];
                    let d2 = dx * dx + dy * dy;
                    if d2 >= r2 {
                        continue;
                    }
                    let t = 1.0 - d2 / r2;
                    self.field[row + gx as usize] += t * t * t;
                }
            }
        }

        let n = pw * ph;
        self.patch.clear();
        self.patch.reserve(4 + n * 4);
        self.patch.push(bx0 as f32);
        self.patch.push(by0 as f32);
        self.patch.push(pw as f32);
        self.patch.push(ph as f32);
        for gy in by0..by1 {
            let srow = gy as usize * w;
            for gx in bx0..bx1 {
                let i = srow + gx as usize;
                let is_sub = self.substrate[i] != 0;
                self.patch.push(if is_sub { 1.0 } else { 0.0 });
                self.patch.push(if is_sub { 0.0 } else { self.field[i] });
                self.patch.push(0.0);
                self.patch.push(0.0);
            }
        }
        self.pending = None;
    }

    fn tick(&mut self, dt: f32) -> *const f32 {
        self.tick_count = self.tick_count.wrapping_add(1);
        self.emit_particles(dt);
        self.step(dt);
        self.cull();
        if self.tick_count % PATCH_EVERY != 0 {
            return std::ptr::null();
        }
        self.build_patch();
        if self.patch.is_empty() {
            std::ptr::null()
        } else {
            self.patch.as_ptr()
        }
    }

    fn set(&mut self, key: u32, value: f32) {
        match key {
            0 => self.emit = value.max(0.0),
            1 => self.gravity = value.max(0.0),
            2 => self.viscosity = value.max(0.0),
            3 => self.stiffness = value.max(0.0),
            4 => self.tension = value.max(0.0),
            5 => self.sticky = value.max(0.0),
            6 => self.blob = value.max(0.5),
            _ => {}
        }
    }

    fn positions(&mut self) -> *const f32 {
        self.pos_out.clear();
        self.pos_out.reserve(self.pos.len() * 2);
        for p in &self.pos {
            self.pos_out.push(p[0]);
            self.pos_out.push(p[1]);
        }
        self.pos_out.as_ptr()
    }

    fn speeds(&mut self) -> *const f32 {
        self.pos_out.clear();
        self.pos_out.reserve(self.vel.len());
        for v in &self.vel {
            self.pos_out.push((v[0] * v[0] + v[1] * v[1]).sqrt());
        }
        self.pos_out.as_ptr()
    }
}

/// Create a sim from the substrate mask in the shared input buffer.
#[no_mangle]
pub extern "C" fn goo_new(w: u32, h: u32, particle_radius: f32, max_particles: u32) -> *mut GooSim {
    let substrate = INPUT.with(|cell| cell.borrow().clone());
    let sim = GooSim::new(
        w as usize,
        h as usize,
        substrate,
        particle_radius,
        max_particles as usize,
    );
    Box::into_raw(Box::new(sim))
}

#[no_mangle]
pub extern "C" fn goo_set(handle: *mut GooSim, key: u32, value: f32) {
    if let Some(sim) = unsafe { handle.as_mut() } {
        sim.set(key, value);
    }
}

/// Debug/profiling: advance the sim but skip the density patch build.
#[no_mangle]
pub extern "C" fn goo_tick_nopatch(handle: *mut GooSim, dt: f32) {
    if let Some(sim) = unsafe { handle.as_mut() } {
        sim.emit_particles(dt);
        sim.step(dt);
        sim.cull();
    }
}

/// Advance one step. Returns a pointer to `[x, y, w, h, ...rgba]` or 0.
#[no_mangle]
pub extern "C" fn goo_tick(handle: *mut GooSim, dt: f32) -> *const f32 {
    match unsafe { handle.as_mut() } {
        Some(sim) => sim.tick(dt),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn goo_particle_count(handle: *mut GooSim) -> u32 {
    match unsafe { handle.as_ref() } {
        Some(sim) => sim.pos.len() as u32,
        None => 0,
    }
}

/// Debug/verification: add a lattice of particles in an axis-aligned box.
#[no_mangle]
pub extern "C" fn goo_spawn_grid(
    handle: *mut GooSim,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    spacing: f32,
) {
    if let Some(sim) = unsafe { handle.as_mut() } {
        let sp = spacing.max(0.25);
        let mut y = y0;
        while y <= y1 {
            let mut x = x0;
            while x <= x1 {
                sim.pos.push([x, y]);
                sim.vel.push([0.0, 0.0]);
                sim.prev_pos.push([x, y]);
                sim.density.push(0.0);
                sim.near_density.push(0.0);
                sim.pressure.push(0.0);
                sim.near_pressure.push(0.0);
                sim.disp.push([0.0, 0.0]);
                sim.normal.push([0.0, 0.0]);
                sim.nsum.push([0.0, 0.0]);
                sim.ncount.push(0.0);
                sim.curv.push(0.0);
                x += sp;
            }
            y += sp;
        }
    }
}

/// Debug stats: `[mean_density, mean_near_density, mean_pressure, count]`.
#[no_mangle]
pub extern "C" fn goo_stats(handle: *mut GooSim) -> *const f32 {
    let sim = match unsafe { handle.as_mut() } {
        Some(sim) => sim,
        None => return std::ptr::null(),
    };
    let n = sim.pos.len().max(1) as f32;
    let md = sim.density.iter().sum::<f32>() / n;
    let mn = sim.near_density.iter().sum::<f32>() / n;
    let mp = sim.pressure.iter().sum::<f32>() / n;
    sim.pos_out.clear();
    sim.pos_out.push(md);
    sim.pos_out.push(mn);
    sim.pos_out.push(mp);
    sim.pos_out.push(sim.pos.len() as f32);
    sim.pos_out.push(sim.pair_count / n);
    sim.pos_out.as_ptr()
}

/// Flat `[x0, y0, x1, y1, ...]` particle positions (debug/verification).
#[no_mangle]
pub extern "C" fn goo_positions(handle: *mut GooSim) -> *const f32 {
    match unsafe { handle.as_mut() } {
        Some(sim) => sim.positions(),
        None => std::ptr::null(),
    }
}

/// Per-particle speeds (debug/verification).
#[no_mangle]
pub extern "C" fn goo_speeds(handle: *mut GooSim) -> *const f32 {
    match unsafe { handle.as_mut() } {
        Some(sim) => sim.speeds(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn goo_free(handle: *mut GooSim) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}
