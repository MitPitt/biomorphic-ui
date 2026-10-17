# AGENTS.md

> **Installing this into a different app? Read [INSTALL.md](./INSTALL.md) instead.**
> This file is contributor architecture; it is not install instructions. Do not
> clone the repo just to consume the packages.

Biomorphic UI: hand-engineered growth rules that look biological, rendered as
borders/growth on DOM elements (Astro + WebGL2). An npm-workspaces monorepo:

- `packages/ca-core` (`@biomorphic/ca-core`) — the shared kernel: engine, runtime, shapes,
  fields, glsl, types. No materials.
- `packages/ca-flora` (`@biomorphic/ca-flora`) — spikes + tree (substrate growth, no wasm/GPU).
- `packages/ca-goo` (`@biomorphic/ca-goo`) — the fluid (wgsl + wasm + `packages/ca-goo/crates/goo`).
- `src/` — the one Astro demo app; `src/materials.ts` composes the registry the
  runtime takes (`createBio({ materials })`). Vite aliases + tsconfig `paths` point
  `@biomorphic/*` at each package's TS source (no package build step).

## Architecture

- **The demo app (`src/`)** is one page per material so the three demos never
  share elements: `pages/index.astro` (spikes), `pages/tree.astro`, `pages/goo.astro`,
  plus `pages/reflow.astro` (the reflow/isolation harness). Each demo page is a thin
  content slot in `layouts/BioDemo.astro` (shell + control panel + the shared
  `lib/demo.ts` bootstrap); a page declares its material and toggle via body data-*,
  and drops `.sub` elements as substrate. The toggle is 2-state for flora/tree
  (grow / clear) and 3-state for goo (source+wall / emitter / wall); `[data-reseed="group"]`
  counters show a group's rebuild count (used by the "group-relative reflow"
  `<details>`, which opens in flow to grow the gap between two groups and shows that a
  settled group is *translated* — a jigsaw piece — rather than re-seeded).
- `packages/ca-core/src/engine.ts` — WebGL2 engine. Ping-pong RGBA32F state, optional static
  `u_field` texture, resolve → blit. Also supports a **live** material: if
  `material.live` exists, the engine skips the shader sim and instead calls
  `live.handle.tick()` each frame, uploading the returned sub-rect patch via
  `texSubImage2D`. There are **two clocks**: the sim tick counter `frame` (fed to
  the sim as `u_frame`) and a render clock `clock` (fed to resolve as `u_frame`),
  so look animations keep running while a settled sim is frozen. `reset()` zeroes both.
  **Settling:** a shader sim stops stepping after `material.settle(params)` ticks
  (spikes declares a finite bound); a live material that declares
  `live.finite` (tree) stops being ticked once `tick()` returns null several
  frames running. Open-ended live sims (goo) are never auto-frozen, since their
  `tick` also returns null while the async wasm/GPU module is still loading.
  Any param change calls `wake()`, which re-arms a settled sim. So neither wastes CPU/GPU once its shape is stable.
  **Instant mode:** an engine `instant` flag (flora demos expose it as a checkbox by `speed`)
  makes `reset()`/`wake()` call `settleNow()` — it runs straight to that settled state
  (shader: `settleAt` steps; finite live: tick until idle), so no intermediate steps are
  rendered. Open-ended goo has no settled state, so the flag is a no-op there.
- `packages/ca-core/src/types.ts` — `Material`, `ParamDef` (with `kind`), `ParamSection`
  (demo panel grouping + `fixed` pins), `settle`, `LivePatch`, `SeedCtx`.
- `packages/ca-core/src/shapes.ts` — analytic substrate shapes (rect/circle/polygon/star) + CSS sync.
- `packages/ca-core/src/fields.ts` — shared `distanceField`, `boxBlur`, `normalField`, `chamfer`.
- `packages/ca-flora/src/reach.ts` — the shared reach-field growth stencil (`REACH_OFFSETS`,
  `snapDirs`, GLSL text). Used by both the Spikes shader and the Tree `spikes base` CPU port.
- `packages/*/src` — one rule set per material (flora: spikes/tree; goo: goo),
  selected by the dropdown (one material per page — no cross-material interaction).
- `packages/ca-core/src/runtime.ts` — `createBio`, the framework-agnostic runtime. Owns
  **one engine per group** and a registry of substrate elements. Each element is
  its **own group by default** (its own automaton), so toggling it or reflowing it
  never disturbs another element; `data-bio-group` *opts into* coupling (a crevice
  pair) so those elements share one field. A material can declare **`coupled`**
  (goo): the runtime then ignores grouping and merges *every* target into one group,
  because a coupled material is one physical field — goo is always a single fluid,
  never per-element. Exposes
  `register/unregister/setMode/setMaterial/reset/wake/resize/scan`. Dev-UX is a
  class/attribute on a div: `data-bio` (material), `data-bio-group` (coupling),
  `data-bio-mode` (`active` = both | `emitter` = source only | `wall` = obstacle).
  Each group gets a seeded RNG (mulberry32) so
  rebuilds reproduce.
- `packages/ca-core/src/index.ts` — core's public entry (`createBio`, `CAEngine`,
  types, and the shared field/glsl helpers the materials import).

### Substrate modes (obstacle vs source)
`SeedCtx` carries two **independent** masks built from each element's
`data-bio-mode`: `substrate` (obstacles: frozen, block/collide, shape the
distance/normal field) and `active` (sources: seed/root/emit). Three modes:
- `active` (**both**) — obstacle + source. `substrate=1, active=1`.
- `wall` — **obstacle** only. `substrate=1, active=0`.
- `emitter` — **source** only, does **not** block: goo spawned on its rim falls
  straight through. `substrate=0, active=1`. Only emitting materials (goo) act on it.

So `active` is **not** a subset of `substrate`; materials that need a source *with* a
shape intersect the two. Wired in `spikes.seedEdges` and `tree.chooseRoots` (seed/
anchor require `active && substrate`; an inert obstacle grows nothing and the outward
normal sums over *all* walls so growth rounds it), and goo `computeEmitters` (WebGPU: free
cells touching `active`, skipping the source's own cells so emitter-only emits just
outside its rim).

Toggling routes through `CAEngine.refreshActivity()`: a shader sim (spikes) must
`reset()` (its tissue is coupled), as must a live backend that lacks the hook (tree).
A live backend that implements `LiveHandle.setMasks(substrate, active)` updates its
static collision field *and* its emitter set in place, so **any** mode change
(active / emitter / wall) is a continuous flow with no restart — the fluid state is
never touched. The WebGPU goo implements this (`WebGpuGoo.setMasks`: recompute +
re-upload the SDF and deep mask via `uploadStatics`, swap emitters, rewrite the
`U_EMITN` count uniform; the Emit
buffer is sized to the emit boundary of the **union of every element footprint**, so
it bounds the count for any mode combination — sizing to "all substrate active"
under-counts when an `emitter`-only element adds sources, and an overflow drops the
whole write, zeroing the buffer into world-(0,0) spawns). (`U_EMITN` is the emitter
*count*, not the
Float32 array length — 4 floats/emitter; getting that 4x too big makes `cs_emit` pick
stale zero entries and spawn at world (0,0), a stray blob in the bottom-left
corner.) **wasm-goo limitation:** the emit set is computed inside `packages/ca-goo/crates/goo` from
its single substrate input, and the wasm handle has no `setMasks`; so wasm still
emits from *all* obstacle walls, has no `emitter`-only mode (it emits nothing there),
and falls back to a reset on a flip until the crate is rebuilt (`npm run wasm`; needs
Rust — not available in every env).

### Param `kind` (controls slider colour)
- `global` (grey) — engine-wide: speed, cell size.
- `structure` (blue) — Runions / construct.
- `cells` (green) — cellular-automata rules.
- `look` (amber) — rendering (thickness, colour).
`reset: true` → changing the slider re-runs `reset()` (field/seed rebuild).
A material may also expose **engine knobs as its own params**: the engine adopts
`params.seedChance` (seed density) and `params.neighborAura` (cross-group aura) in
`reset()` if the material declares them, so an ordinary slider drives the engine and the
knob only appears on materials that use it (flora), not on every page.

### Two execution models
- **Shader sim** (spikes): local field CA, one fragment pass per tick.
- **Live CPU** (tree): `live.start(ctx)` returns `{ initial, handle }`; `handle.tick()`
  advances the algorithm and returns a changed-rect `LivePatch`.
  Also used for anything non-local (space colonization, agents).
- **Live WASM** (goo): same `live` seam, but the tick is a Rust crate compiled to
  `wasm32-unknown-unknown` (`packages/ca-goo/crates/goo`, hand-rolled PBD fluid) with a raw C ABI — no
  wasm-bindgen. `goo.ts` loads the module async; `tick` returns `null` until ready.
- **Live WebGPU** (goo, preferred when available): the same `live` seam with a
  WGSL compute solver (`packages/ca-goo/src/goo.wgsl` + `goo-webgpu.ts`). The
  whole sim, emission, culling and metaball splat run on the GPU; only the
  density field is read back (async, throttled, non-blocking). Falls back to the
  wasm handle if `navigator.gpu` is missing or init fails. `backend` param picks.

## How to add a new bio-rule material
1. Create `packages/ca-<family>/src/<name>.ts` exporting a `Material`.
2. Set `sim` + `resolve` shaders (field rules) **or** `live` (CPU/agent rules).
3. Tag every param with a `kind`; mark `reset: true` for field/seed params.
4. Add it to that family's `src/index.ts` `materials` map; the app composes families
   in `src/materials.ts`, which it hands to `createBio({ materials })`.
5. Seed/emit from free cells touching an **`active`** cell; `substrate` blocks/collides
   for obstacles. If the rule needs a source *with* a shape, require `active && substrate`
   (as spikes/tree do) so `emitter`-only elements (source, no obstacle) don't seed it.
6. **Verify without a GPU**: replicate the rule in a throwaway Node script
   (`/tmp`) and print ASCII / assert shape+convergence, since the agent env has
   no WebGL. Then `npm run build`. A raw-ABI wasm module can be instantiated in
   Node directly (`WebAssembly.instantiate(bytes, {})`) to drive/verify the sim.

## Roadmap — bio rules to test

Priority order. Each item: algorithm → render → key params → effort.

1. **Snowflake / dendritic solidification** (phase-field, hexagonal anisotropy + noise).
   Seed on the element edge; grows a crisp ice crystal. Render white/ice, rim light.
   Params: growth rate, anisotropy, noise, reach. Effort: medium (field shader).
   Why: your example; symmetric growth on a box reads instantly as "crystal on UI".
2. **Physarum / slime mould** (Jones 2010) — agents + diffusing trail.
   Render trail intensity as veins. Params: sensor angle/dist, turn, deposit, decay.
   Effort: high (needs agent state → live CPU or the `packages/ca-goo/crates/goo` wasm seam).
   Why: transport networks, veins, best for connecting elements.
3. **Reaction–diffusion — Gray–Scott + Meinhardt venation**.
   Render `b` channel via palette. Params: feed/kill/diffusion. Effort: low (shader).
   Why: organic fills/veins on cards; cheap always-on life.
4. **DLA / mineral dendrites / lightning** — stochastic accretion, anisotropy bias.
   Render dendrite + glow. Effort: low-medium. Why: cracks/veins for damage/errory states.
5. **Lichen / moss (Eden growth + palette + slow creep)**.
   Effort: low. Why: literal biomorphic-UI "growth on idle elements".
6. **Cellular Potts / foam (Voronoi/Lloyd relax)** — tissue panels.
   Effort: medium (live CPU). Why: neutral biome textures behind content.
7. (stretch) **Excitable media** (FitzHugh–Nagumo spiral waves) for pulsing alerts;
   **phyllotaxis** for decorative spirals; **Boids** for cursor trails.

## Framework refactor (before adding many rules)

Generalise the current per-material step into a rule pipeline:

```
Rule   = { id, kind, params, step(ctx) -> LivePatch | null }
Recipe = { rules: Rule[] }        // run in order each frame, merge patches
```

`Tree` becomes `[spikesBase, spaceColonization, leaves]`; `Spikes` becomes
`[fieldShader, fieldShader]` (two independent automata) and `Goo` `[sphLiquid]`.
The leaf CA already has a `leaf steps / frame` slider — this refactor generalises
that to N rules. (Tree's old `runions steps / frame` slider was removed: it just
scaled the growth rate, which the global `speed` already does.)


## Learnings / decisions

Package-specific detail lives next to the code — goo internals in
`packages/ca-goo/AGENTS.md`, the spikes/tree growth rules in
`packages/ca-flora/AGENTS.md`. Cross-cutting notes:

- **Live materials:** one CPU iteration per `tick`, stream changed cells as a
  `LivePatch` (bbox) via `texSubImage2D`; the engine also runs `speed` ticks/frame.

- **Framework runtime & reflow (`runtime.ts`).** Grouping is the whole story: a CA
  field is valid iff *every substrate cell rasterized into it keeps the same grid
  coordinate*, so a window resize, an element resize, an element **translate** (pushed
  by content above), or any group member's reflow invalidates that group and only that
  group. `createBio` therefore makes each element its **own group by default**
  (coupling is opt-in via `data-bio-group`) and rebuilds a group only when one of its
  *own* target rects changed.
  Detection keys off **rect diffing, not just `ResizeObserver`**: ResizeObserver misses
  pure translation, so a per-target RO *and* a `documentElement` RO (any content-height
  reflow) both run a document-coordinate rect diff and schedule a rebuild only for
  changed groups (rAF-debounced; scroll-safe because rects use document coords).
  Rebuilds are deterministic (per-group mulberry32), so an unchanged layout regrows
  identically and a change reads as a clean re-grow rather than a different plant.
  **Layers vs instances:** Spikes is one automaton per engine, not two instances; a
  second *engine* is only
  for a different material or a genuinely uncoupled group (each costs a WebGL context —
  budget). **Goo is `coupled`: the runtime keeps every target in ONE group**, so goo
  is a single fluid per page (never per-element — separate instances would let goop
  fall through other goop). Switching to/from a coupled material rebuilds the group
  layout (`rebuildLayout`), preserving each element's mode and the engine globals.
  A goo group that couples walls+emitters is
  **not reflow-tolerant**: moving a wall invalidates its SDF and every
  particle; freezing + accepting intersection is the only cheap fallback (hard-object
  physics is a different project).

- **Neighbours as obstacles (independent groups, one mass).** Independent groups still
  overlap when close: group A's grid spans the whole document but rasterizes only its
  *own* targets, so a nearby box B is invisible to A and A's growth spills over it. Fix:
  `CAEngine` takes an `obstacles()` provider (runtime supplies every element owned by a
  *different* group), rasterized as **substrate only, never as `active`** — so it blocks
  but never seeds. Because that injection is exactly how an inert `wall` element already
  behaves, no material changed: spikes' `seedEdges`/tree's `chooseRoots` still require
  `active && substrate`, so they grow *around* the neighbour instead of from it. Reflow
  independence is preserved: obstacles are sampled only at *this* group's reset, so a
  neighbour's translate never rebuilds this group — the tradeoff is a **snapshot** (if a
  neighbour later moves toward this group, this group's already-grown tissue can overlap
  its new position until this group next resets; moving away just leaves a gap). Enabled
  by default (`createBio({ collideNeighbors: false })` disables); `scan()` does a final
  pass so a batch of sequentially-registered elements sees each other symmetrically.
  **The box obstacle is not enough for long-range live growers.** A tree's branches aren't
  in the substrate mask, and at reset a neighbour has no branches yet, so a *snapshot*
  can't stop branch-on-branch crossing; spikes look fine only because their reach field
  is bounded (and they're box-blocked early). So the runtime also shares one document-grid
  **`Occupancy`** (`seedCtx.occupancy` + `token`): live CPU sims (tree) refuse to birth or
  paint into a cell owned by a foreign token, and claim their own cells (`paint`/birth/
  leaves). It's monotonic and same-thread, so two trees meet and never both claim a cell —
  while still **not** coupling reflow (a move doesn't rebuild the other; it just re-samples
  the live map on its next reset). Shimmed per-engine — a standalone `CAEngine` gets none,
  and only materials that opt in (`Material.usesOccupancy`, i.e. tree) size/claim/scan it,
  so spike-only pages pay nothing.
  **`neighborAura`** (px, `createBio`) adds a purely *cross-group* stand-off: a foreign
  group's box is grown by it (substrate dilation in `rasterizeMasks`) and a foreign group's
  live tissue is dilated by it too (tree's `foreign()` scans an `aura`-cell neighbourhood in
  the occupancy map), so neighbouring trees leave a crown-shyness gap instead of touching.
  It is never applied to a group's own elements, so it doesn't change their own behaviour.
  **Goo is unaffected and needs no care here:** it's `coupled`, so every target is one
  group and there is never a "foreign" element (both paths go inert). Only a future page
  with multiple *independent* goo instances would make this relevant.

- **Settled groups translate rigidly (jigsaw move).** A settled group's field is
  self-contained in its state texture, so when the runtime's rect diff sees a **uniform
  pure translation** (every target keeps its size and moves by the same delta) it does
  *not* rebuild: it calls `CAEngine.translateBy(dx, dy)`, which merely CSS-translates the
  group's canvas, so the finished shape slides as one piece and the group's re-seed counter
  stays put. Any other change — a resize, members diverging, or a sim that hasn't settled
  (`CAEngine.settled`) — falls back to a full `reset()`, and `reset()`/`resize()` clear the
  transform. This needs the document RO to actually fire, so a demo page must **not** pin
  `html, body { height: 100% }`: a viewport-sized root never resizes when content grows, so
  the translate would never trigger. `SeedCtx.ownSubstrate` (the group's *own* box, foreign
  obstacles excluded) lets a live group (tree) render only its own box, so a rigid move
  doesn't drag copies of neighbour boxes along; goo is open-ended (never settles) and
  coupled, so it always rebuilds.

- **Explicit freeze/unfreeze; a group that resizes itself.** Auto-settle is a
  *derived* freeze (`CAEngine.settled`); apps can also hold a group deliberately via
  `CAEngine.freeze()` / `unfreeze()` / `frozen` (runtime `bio.freeze / unfreeze /
  frozen`). `frozen = manualHold || settled`, and the runtime's rigid-translate path
  now keys off `frozen` (not `settled`), so a **partly-grown** group can be frozen
  and still slide as one piece. A *manual* freeze additionally makes the runtime
  **defer** a rebuild: a detected size change (or divergent move) while frozen is
  recorded on the group and applied on `unfreeze()`/`reset()`, instead of rebuilding
  every frame — so an animated accordion can be held through its transition and
  re-grown once. `unfreeze()` with nothing deferred resumes (`wake()`); with a
  deferred change, or after a rigid translate (whose baked obstacles are now stale),
  it rebuilds. `reset()` / `wake()` / any rebuild clears the hold.
- **A group can change its own size (FAQ/accordion).** The rect diff already rebuilds
  — never translates — a group whose *own* target changed size, since a height change
  moves the perimeter relative to the grid's cells. So a card whose nested `<details>`
  expand re-rasterizes and re-grows on each open (its re-seed counter ticks) while
  neighbours below merely translate. `pages/index.astro` shows both, plus a
  **condition-based redraw**: `data-bio-regrow-on` (`open`/`close`) +
  `data-bio-regrow-group` + an optional `data-bio-regrow-gate` checkbox id make
  `demo.ts` rebuild a group when a `<details>` toggles — used so the "grow spikes"
  toggle re-fits when the group-relative-reflow panel *closes* instead of sliding its
  frozen spikes over the group above. The demo panel's `freeze (hold shape)` checkbox
  drives `bio.freeze`/`unfreeze` on every group.
- **The canvas is document-sized and re-fitted on every rebuild.** An engine's canvas
  spans the whole document (`max(innerHeight, documentElement.scrollHeight)`), so growth
  stays attached to targets on scroll. It used to be sized only at construction / window
  resize, which clipped a target that a content reflow had pushed below the old extent: the
  group translated while settled (canvas CSS-translated, fine), but the moment anything
  rebuilt it (`setMode` → `refreshActivity` → `reset()`, a param reset, `regrow-on-close`)
  the grid no longer covered the button and only the top half grew. `fitCanvas()` (split out
  of `resize()`) is now called at the top of every `reset()`, so the grid is re-fitted before
  rasterizing; the translate path is unchanged (no reset, no re-fit). Each group has its own
  canvas, so one group's re-fit never disturbs another.
- **Reset is the cost centre; the master lever is the cell budget.** Every `reset()`
  rasterizes the substrate, builds the seed + normal field and uploads textures — all
  O(grid cells) — and each group's grid spans the whole document, so a tiny `cellSize`
  (which hits the grid cap) is expensive *per group*. The dominant cost at a fine grid was
  the **normal field** (`chamfer` + two full-res `boxBlur`s ≈ 290 ms/group at 4M cells),
  so two structural fixes now apply: (1) `reset()` **caches** the field — it depends only on
  the rasterized substrate + field params, and `rasterizeMasks` returns a `key` over exactly
  those inputs (box rects, substrate membership, shape spec, grid, params), so a plain reset
  or an active↔wall toggle *reuses the field texture* with no CPU build or upload; (2)
  `Material.field` may return `{data,w,h}` and spikes builds the normal field at a capped
  resolution (~400k cells) that the engine upsamples with `LINEAR` (`u_field` is sampled
  via `texture(u_field, (P+0.5)/textureSize(u_state))`, not `texelFetch`), which took the
  build from ~290 ms to ~18 ms. Other cheap wins: only `texA` is uploaded (a shader step
  fully writes `texB` before its first read, and the live seam only uses `texA`); `u_field`
  is a tightly packed 2-channel `RG32F` (was RGBA32F); `boxBlur` uses precomputed clamp
  index tables instead of per-element `Math.min/max`; `seedEdges` *dilates the source cells*
  instead of testing every free cell × 8 (O(sources), order-preserving so seeds are
  unchanged); and `refreshActivity` resets a shader sim rather than building masks twice.
  The real bound is `cellBudget` (`createBio`) / `maxCells` (`CAEngine`) — the cap on each
  group's grid (default 4M cells; was 8M). Memory, seed/field CPU, upload and per-step sim
  cost all scale with it (8M cells = 128MB RGBA32F per state texture, ×2 for ping-pong,
  *per group*). Instant mode runs the whole `settleAt`-step sim in one shot, so its latency
  scales the same way — lower the budget, not the settle bound.
- **Aliasing vs `boxBlur`; upsample filter.** `boxBlur` smooths the *growth-direction*
  field (it shapes spikes), not the rendered edge. The rendered edge quality is the blit's
  reconstruction of the resolve texture, so `CAEngine.setUpsample(mode)` picks it (a
  look-only toggle, also honoured on the next `createTargets`): `linear` (default; hardware
  `LINEAR` interpolates the signed coverage → smooth silhouette), `nearest` (grid pixels),
  and `cubic` (Catmull-Rom, 4 taps/axis) / `lanczos` (Lanczos-3, 6 taps/axis), which the
  blit shader gathers manually via `texelFetch` (WebGL hardware filtering only offers
  NEAREST/LINEAR) `BLIT_FS` in `glsl.ts`. The demo panel exposes `cell budget` (`maxCells`,
  live via `bio.resize()`), `cell size` and the `upsample` dropdown.

## Conventions
- No comments unless asked; match existing file style; one material per page.
- Verify edits: `npm run build`; run the dev server if available.
- **Shader uniforms:** the engine binds `u_<key>` from each `ParamDef.key`, plus the
  built-ins (`u_state`, `u_field`, `u_frame`, `u_tex`). So every `uniform ... u_x` must
  have a param `x`. `npm run build` runs
  `scripts/check-shaders.mjs` first (also `npm run check`): it fails on a used-but-
  undeclared `u_*` (compile error) and warns on a declared uniform with no param
  (silently stays 0). `wrapFragment` runs the same check at import time.
- Prefer raising slider maxes generously (leaf height, CA steps, height, density)
  so extremes are reachable; defaults stay tasteful.
