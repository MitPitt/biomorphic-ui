# AGENTS.md — @biomorphic/ca-flora

> Spikes + tree: substrate growth on the shared WebGL2 engine, no wasm/GPU.
> Depends only on `@biomorphic/ca-core`. Shared engine/runtime/reflow notes live in the
> root AGENTS.md and `packages/ca-core/`.

## Learnings / decisions

- **Tree = pure space colonization. No CA mix.** Interleaving a CA crevice-fill
  with Runions was tried and abandoned: Runions is a global point process and a
  local CA doesn't feed back into it, so interleaving bought nothing; and any
  fill of an *enclosed gap* is bounded by that region, so it always reads as a
  rectangle (noise just adds holes). The `crevice attractors` knob (attractors
  seeded in narrow gaps) was also removed — it didn't do the intended job, and
  the `spikes base` crust now handles the gap/crust look. Do not re-add a mask
  flood.
- **Tree `spikes base`:** a CPU port of the Spikes reach-field, computed with a
  **max-cost Dijkstra** (O(n log n)) over a band near the substrate — not repeated
  sweeps. Rendered as thick wood so its spiky outline shows. The `solid gaps`
  option was removed (the spikes base supersedes it).
- **Tree leaves (third, optional stage).** The same parametrized reach-field
  (`makeSpikeSolver`/`spikeField`, shared with `spikes base`) is run *again*,
  once the twigs are stable, on the grown tissue as its substrate, at low
  `leaf height` — this is the "thin fern" CA dressed onto the twigs as leaves.
  Keyed to finish (`alive.length === 0 || iter >= maxIter`). `makeSpikeSolver`
  exposes an incremental `step(maxPops)` instead of only a one-shot `spikeField`:
  the max-cost Dijkstra finalizes nodes in decreasing reach order, so popping a
  batch per tick grows the field outward from the seeds — the leaf stage runs it
  live, `leafSteps` nodes/frame, instead of snapping to the final shape (`spikes
  base` still runs it to completion via `step(Infinity)`). Leaf cells are marked
  by a **negative `b` channel** (`b = -1`; wood/store use `b >= 0`), so the
  resolve can colour them green without a new channel. `leaves` (0/1) toggles the
  stage; `leaf*` params retune the CA. Wiring `spikeSpacing` here also made that
  slider live (it was previously dead).
- **Tree respects walls as real obstacles.** Nodes are only *painted* around
  substrate, so blocking must also happen in `advance()`: a new node is not born
  inside a substrate cell (a limb stops at the wall instead of marching through),
  and crown attractors inside substrate are dropped so they don't keep tugging
  limbs into the wall. Roots anchor only on `active` cells, but their outward normal
  sums over *all* walls, so growth rounds an inert obstacle.
- **Shape inset (spikes `inset`, CSS px).** The engine offsets every target's
  substrate *before* seeding: analytic shapes use a signed distance threshold,
  text samples a distance field built from its glyph mask. Positive = inward
  (erode), negative = outward (dilate), and the runtime's `neighborAura` combines
  as its opposite. On text, a positive inset pulls the seed rim under the glyphs,
  so the grid-jagged spike bases are hidden by the text; thin strokes cannot
  survive more than roughly half their stroke width. The inset joins the field
  key, so moving it re-rasterizes and re-grows.
- **Reach fields quantize growth direction to the stencil.** The Spikes field
  advances one grid step at a time, so a spike tip can only point along a step
  direction: with the bare 8-neighbourhood it snaps to the 8 lattice rays
  (multiples of 45°) even when the driving normal is arbitrary (verified: a 30°
  normal yields a 45° tip). Fix = concentric shells of longer offsets
  (`reach.ts`), tunable via `growth directions` (8→48, default 28 ≈ 22.5° steps,
  48 ≈ 15°). Cost model is `len * (max(fwd,0) + side*sharp)`; the first 8 offsets
  reproduce the old behaviour exactly. **A concave (pinched) width profile is
  unreachable** — no `sharp(p)` curve yields it (verified: every profile is convex
  or straight; width is monotonic outward). `curve` is therefore a base-width dial:
  `+concave` narrows the base (separated needles), `−convex` widens it (merged
  crown/flames). Spikes still merge when base half-width (~`height/sharpness`)
  exceeds `spacing`, so gothic teeth need `spacing` > base width.
- **Controlled zigzag/snake = coherent-noise rotation of the normal.** The field
  is laterally symmetric, so it cannot kink or branch on its own (the old
  christmas-tree/spiral came from the removed heading+turn model). Perturbing the
  growth normal with *smooth* value noise (`snake / drift` + `drift scale`) bends a
  spike coherently: ~1.2 → lean, ~2.2 → S-snake, ~3 → fork. Sharp lightning kinks
  with real branching still need a heading-carrying tip model.
- **Global gap-filling belongs to a different rule**, not Runions — e.g. a
  reaction–diffusion/phase-field rule where the *field* is the shape.

- **Filling box interiors was removed (Spikes `interior`).** It had three modes
  (0 none / 1 solid / 2 **inward spikes**) — but both non-none modes were dropped:
  solid painted substrate cells with the styled material, and inward spikes ran a
  second, fully independent automaton (`substrate2` / `seed2` / `field2`, same sim
  shader with `u_layer = 1`, its own state texture exposed as `u_state2`) whose
  substrate was *everything outside the boxes* (`layer2Substrate`), so it grew only
  inside boxes. Both read as "stuff inside the frame", which this repo (a library of
  natural-looking **frames**) doesn't want. With the feature gone, the engine's whole
  optional second-layer path was deleted too (`u_layer` / `u_state2` / `u_field2`,
  the second state/field textures, `emptyState`); `resolve` now reads a single
  `u_state`. Re-adding interior treatments belongs to a *different* rule that owns
  the fill as its shape, not to Spikes.
- **Spikes look = the resolve pass.** `RESOLVE` outputs `(coverage, colour)`; the
  reach value `g` is treated as a height field, its gradient gives a fake surface
  normal, and a `style` param (0 bone / 1 metal / 2 gold / 3 neon / 4 ice) picks the
  shading. Metal/gold reflect a procedural gradient sky + horizon streak with
  fresnel, animated by `u_frame`. Add styles by branching on `u_style`; the outside
  band carries the style rim colour so the AA edge blends.

- **Neighbours block growth (core runtime).** Independent groups no longer overlap when
  close: the runtime hands each group's engine the *other* groups' elements as inert
  obstacles (`CAEngine` `obstacles()`, substrate-only). Spikes needed no change — they
  already treat inert `wall` substrate as a block but not a `seedEdges` source — so their
  bounded reach field simply stops at a neighbour's rim. **Tree is different:** its
  branches aren't in the substrate mask and at reset a neighbour has no branches yet, so a
  box obstacle can't stop branch-on-branch crossing. Tree therefore also uses the runtime's
  shared live-tissue **`Occupancy`** (`ctx.occupancy` + `ctx.token`): `advance()` refuses to
  birth a node in a cell a foreign token owns, `paint()`/`leafStep()` refuse to paint such
  cells, and every cell it does grow (seeds, base crust, limbs, leaves) is `claim`ed for its
  own token. Two independent trees thus meet and never cross. Reflow stays independent — a
  neighbour moving never rebuilds this group; it only re-samples boxes + the live map on its
  next reset. Tree renders only its *own* box as trunk (`ctx.ownSubstrate`, foreign obstacles
  excluded), so a settled tree can be translated rigidly (a jigsaw piece) without dragging
  copies of neighbour boxes along. A cross-group `neighborAura` (px) makes `foreign()` scan
  an `aura`-cell neighbourhood, so a tree keeps a crown-shyness gap from a neighbour's
  tissue (its own tissue is always exempt). See the root AGENTS.md.
