# AGENTS.md — @biomorphic/ca-goo

> The liquid family: one position-based fluid, WebGPU compute backend with a
> wasm fallback. Depends only on `@biomorphic/ca-core`. Only emit-related details are
> here; the shared engine/runtime live in the root AGENTS.md and
> `packages/ca-core/`.

## WASM / GPU plan (for scale)

- Keep `LivePatch`/`LiveHandle` as the seam. A Rust crate (`wasm32`) operating on
  the shared `WebAssembly.Memory` buffer implements the same `tick`; JS just
  uploads patches. **Implemented for Goo** (`packages/ca-goo/crates/goo`, hand-rolled PBD fluid).
- Build: `npm run wasm` (needs rustup + `rustup target add wasm32-unknown-unknown`)
  compiles `packages/ca-goo/crates/goo` and copies the artifact to
  `packages/ca-goo/src/goo.wasm`, imported via `?url` and compiled/instantiated
  in JS. `npm run build` does **not** need Rust — the committed `.wasm` is bundled.
- A GPU-compute path is **implemented for Goo** as a WebGPU port of the PBD
  solver (`goo.wgsl` + `goo-webgpu.ts`), preferred when `navigator.gpu` exists
  with automatic fallback to the wasm handle. Key design points (and the fixes
  for why the first, rolled-back attempt was slower):
  - **No per-tick readback/sync.** All particle state, emission, culling and the
    metaball splat are GPU passes; only the density field is copied to a mapped
    staging buffer, throttled to every `PATCH_EVERY` (3) ticks, and consumed a
    frame or two later when the `mapAsync` resolves. The render loop never waits.
  - **Gather, not scatter.** The pair passes are written so each particle sums
    over neighbours and writes only its own accumulator. That is numerically
    identical (all pair terms are symmetric) but needs no f32 atomics, which
    WebGPU lacks. Only u32 atomics are used: a fixed-capacity bucket grid, a
    free-list allocator, the emit accumulator, and fixed-point momentum/field
    sums.
  - **Per-pass bind groups.** Each entry point gets its own explicit-subset bind
    group (layout `auto` per pipeline), so a pass never exceeds the default
    `maxStorageBuffersPerShaderStage` of 8 (the first attempt bound 12 in one
    shared group and every submit was rejected).
  - **One compute pass** with ~20 dispatches per tick (implicit barriers between
    dispatches); no per-stage pass boundaries.
  - **No neighbour cap: the grid is a per-cell linked list** (`GridHead` +
    `GridNext`), not fixed-capacity buckets. A bucket cap is a trap: compressed
    goo at large `particle size` packs far more particles into a cell than any
    sane cap (measured up to ~150), and truncating the neighbour list undercounts
    density -> weak pressure -> more overlap -> more truncation, which shows up
    as the stream "twitching, then breaking" and flying. The linked list is
    O(n) memory, never truncates, and matches the wasm solver exactly.
  - **Disposal/recycling.** The wasm swap-removes into a dense `Vec` (a culled
    particle's old splat `bbox` is folded into `pending` so the patch clears it);
    the GPU keeps a free-list allocator (`free + alive = top <= maxpart`, slots
    reused by emission, which runs before cull) and clears the whole field each
    patch, so culled goo never ghosts. The off-grid cull is an *inverted*
    inside-test (`inGrid`), so non-finite positions are also disposed instead of
    persisting and poisoning neighbours' density.
  - Offline check: `npm run check:wgsl` (builds `crates/wgslcheck`, a naga
    validator) parses+validates+round-trips `goo.wgsl` without a GPU.
- Still to port: Physarum, DLA, CPD, L-systems, phyllotaxis.
- Introduce `Material.executor: 'shader' | 'cpu' | 'wasm' | 'gpu'` behind the
  existing interfaces so rules port 1:1 without touching call sites.


- **Goo = WASM position-based fluid (`packages/ca-goo/crates/goo`).** A hand-rolled Clavet-style
  PBD particle fluid ("Particle-based Viscoelastic Fluid Simulation", 2005), not
  SPH. It replaced salva2d DFSPH after hitting SPH's limits (below). Grid units
  (1 cell = 1 unit, `particle_radius` 1). Free cells touching the substrate emit
  goo; the substrate is a signed-distance field for collision. Non-obvious parts:
  - **Why PBD, not SPH.** salva's `WCSPHSurfaceTension` summed to only ~0.4x its
    coefficient (a max of 6 is ~2.5 cells/s² vs gravity 30, so maxing it did
    nothing) and blew the fluid up at useful magnitudes; `Akinci2013` (FIXME'd for
    2D) is unstable too. Worse, an incompressible pressure solve *squirts* fluid
    out of a narrow gap like a cannon. A position-based solver relaxes density by
    moving particles, so cohesion/viscosity can be cranked without exploding and
    confined gaps stay calm. There is no mature Rust 2D PBD-fluid crate, so the
    solver is hand-rolled.
  - **The step (Clavet):** gravity + wall adhesion -> explicit viscosity -> advance ->
    double-density relaxation (pressure `k*(rho-rho0)` plus a small repulsive
    near-density term) applied as position displacements -> surface tension ->
    wall collision -> velocities re-derived from `(x - x_prev)/dt` -> wall friction.
    `rho0` is fixed at the rest packing density (~0.75, scale-invariant).
  - **Surface tension is position-based curvature flow, not a force.** `F=sigma*kappa*n`
    (CSF) is unusable here: the density-gradient normal is noisy in 2D, so kappa has
    mixed signs and the force just diffuses the fluid (both force signs *expanded*
    the blob). Instead, surface particles (strong density gradient) are pulled toward
    their neighbour centroid as a *position displacement* (Laplacian / surface-area
    minimisation). It is dissipative, hence stable, and genuinely contracts/rounds
    goo (a blob's meanR 8.5 -> 3.5 at sigma 0.1) and slows a gap stream. The mean
    displacement is subtracted from every particle so the step is
    **momentum-conserving** -- otherwise the one-sided inward pulls bleed a
    cluster's fall speed (balls fell far slower than loose drops). This is the
    `surface tension` slider. Neither the rest density (bulk compression) nor the
    near-density term (anti-clustering) is surface tension.
  - **Cap the *total* displacement, not per pair.** Per-pair caps sum over ~15
    neighbours into a large per-particle move, and the derived velocity `dx/dt`
    then becomes huge -- that *is* the cannon. Accumulate per-particle and clamp the
    total (0.12 cells), plus a hard speed cap (55 cells/s) and a clamped collision
    push. Confined goo then pools instead of firing out.
  - **Emit onto a rest-spacing lattice, never overlapping**, and attach to existing
    goo: a freshly emitted particle placed in free space is isolated (no cohesion)
    and just falls away. Emission searches a small window around the emitter's
    outward site for a free lattice site that *touches* existing goo; only when no
    goo is near does it seed a single particle.
  - **Wall collision = signed distance field** (chamfer transform of the substrate).
    Push out along the sdf gradient (push clamped); near walls apply an inward
    *adhesion* acceleration plus tangential friction and normal damping (the `wall
    stickiness` slider). Adhesion holds goo on the *underside*/sides of boxes --
    without it, edge goo just falls off. Cull only goo *deep* inside a box.
  - **Adhesion is rest-distance, not a constant pull from the surface.** An
    adhesion whose weight peaks *at* the wall (`wgt = 1 - s/reach`) pumps
    particles into the surface, collision bounces them back out, and at large
    `particle size` the fluid gains net momentum and self-propels (observed as
    drops drifting sideways then "falling" upward; reproduced in the wasm too).
    Adhesion is now zero at the resting gap (`r*0.9`, the collision margin) and
    rises with separation, so it wets/holds without doing net work. Verified in
    the CPU reference: `r=3, surface tension 0.8` drifts to the wall before the
    fix and stays centred after, with side-cling unchanged at `r=1`.
  - **Bulk-translation projection.** Even with rest-distance adhesion, wall
    adhesion plus the elastic collision inject *net momentum* at large
    `particle size`, so the whole mass slowly slides and can climb a wall (the
    observed "drifts sideways, then falls upward, changing direction every few
    seconds"). Partial damping only reaches a steady drift (injection/damp), so
    the step removes **all** net horizontal velocity and any net **upward**
    velocity each iteration: bulk drift and levitation become impossible while
    gravity still pulls the fluid down and local motion (blobs, drips) is
    untouched. Verified in the f32 wasm over 60 s: `meanX` stays within ~68–71
    at `r=3, tension 0.8` and high stickiness, with pooling and side-cling
    preserved. Same in `goo.wgsl` (`cs_vx_sum`/`cs_vx_damp`, fixed-point sums in
    `Counter[C_MVX]`/`C_MVY`).
  - **Density is a metaball splat, not a per-cell count.** A wider `blob` radius
    (~3.8) raises blob/stray contrast so a lone stray particle (peak 1.0) falls
    below `threshold` and the resolve hides it -- no need to cull isolated particles.
  - **Performance.** The pair passes dominate (the density patch is minor). Compute
    density, near-density, the neighbour centroid *and* the surface-gradient normal
    in **one** pass -- merging them saved ~40%. Skip the `sqrt` on rejected
    candidates (squared-distance early-out). Cost is super-linear because goo
    *compresses* under its own weight (rest density 0.75 -> ~2.4 when piled up),
    which inflates the neighbour count; a higher `stiffness` holds rest density, so
    it is both faster and more correct (default raised to 60). ~25 ms/tick at 20k
    particles, ~56 ms at 40k, on a 0.5M-cell page. Beyond that needs GPU (WebGPU
    compute); WebGL2 cannot do particle neighbour search.
  - **Patch cost is the real budget.** A full-page grid is ~0.5M cells; rebuild and
    upload the density only every 3rd tick (`PATCH_EVERY`); the sim still steps
    every tick. Culled particles' old splats are folded into a pending rect so
    nothing ghosts. ~1.6 ms/tick at ~3k particles, `speed` 2.

  - ABI is raw C (no wasm-bindgen): `goo_input_reserve` → copy substrate →
    `goo_new` → `goo_set(key,...)` → `goo_tick(dt) -> *const f32` = `[x,y,w,h,...rgba]`.
    The crate is deterministic and instantiable in Node, so the sim is verifiable
    without a GPU (`/tmp` harness: gravity → pooling → detached drops).
  - **WebGPU backend** (`goo.wgsl` + `goo-webgpu.ts`) is the *same algorithm*,
    ported pass-for-pass, and is preferred when available (see the WASM/GPU plan
    above). Differences worth knowing:
    - SDF / deep-interior mask / emitters are precomputed in TS (`chamfer`,
      `chebyshev`, `computeEmitters`) since they are static; the WGSL does the
      per-tick work.
    - Emission, culling and the splat are GPU passes; particle positions are
      never read back. Only the fixed-point density field (`SPLAT_SCALE` 1024,
      matching the wasm raw `t³` sums) is copied to a mapped staging buffer every
      3rd tick; the CPU packs the RGBA patch (union with the previous rect so
      vanished goo is cleared) and the engine `texSubImage2D`s it.
    - Verified without a GPU two ways: `npm run check:wgsl` (naga) validates the
      shader, and a `/tmp` CPU transliteration of the exact pass pipeline
      confirms stable pooling/drip detachment.
    - The `backend` param (1 = gpu/auto, 0 = wasm) toggles it for A/B testing.
    - **Instance lifecycle:** the backend is deliberately *not* a global singleton.
      A module `active` slot meant constructing any new `WebGpuGoo` disposed the
      previous one, which broke as soon as the group layout was rebuilt (or two
      instances briefly coexisted) — the previous fluid froze and the newest one
      clobbered the rest. Instances now live in a module `Set` and share one
      `GPUDevice` (a module-level `sharedDevice()` promise). The wasm path is
      likewise per-handle (`generation`/`sharedSim` globals removed); each handle
      owns and frees its `GooSim`. `CAEngine.reset()` disposes the previous
      `LiveHandle` (`LiveHandle.dispose`) before starting the next, which keeps GPU
      buffers / wasm sims from leaking on every reset.
