# Biomorphic UI

Hand-engineered growth rules that look biological, rendered as borders and
frames on ordinary DOM elements.

The idea: a web UI is made of boxes, and a box is really just a frame. Instead of
styling that frame with a static `border`, this library grows it — with cellular
automata and agent simulations that read as plausible organic matter (spikes,
trees, goo fluid) while still respecting the box's geometry. 

Each rule is tuned to look good on UI-scale rectangles at 60fps.

See live demo at https://biomorphic.mitpit.com/

**Using this in another app?** Start with [INSTALL.md](./INSTALL.md) — it is the
complete install/bootstrap guide. `AGENTS.md` documents the library's internals
and is not installation documentation.

## The three rule families

| Material | What it is                                                                                                  | How it runs                 |
| -------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| spikes   | A reach-field CA: stalagmite/cone tissue grown outward from the substrate rim.                              | WebGL2 fragment shader      |
| tree     | Space colonization (Runions): roots anchor on edges, limbs reach for attractors, optional fern-like leaves. | live CPU                    |
| goo      | A position-based particle fluid that pools, drips and clings to edges.                                      | live WebGPU (wasm fallback) |

Pick one material per page; each page's elements share that material.

## Packages

An npm-workspaces monorepo. Packages ship raw TypeScript source (no package build
step), so they need a TS-capable bundler. When installed as a dependency their
`exports` point at that source and Vite resolves them directly; the path aliases
in this repo are for developing the demo app itself, not required for consumers.
The goo package uses Vite asset imports (`?url` for wasm, `?raw` for WGSL), so a
Vite-based bundler is required when using it.

| Package                | Contents                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `@biomorphic/ca-core`  | Engine, runtime (`createBio`), shapes, fields, GLSL, types. No materials. |
| `@biomorphic/ca-flora` | `spikes` + `tree` (substrate growth, no wasm/GPU).                        |
| `@biomorphic/ca-goo`   | `goo` (WGSL + wasm + `crates/goo`).                                       |
| `src/`                 | The Astro demo app — one page per material.                               |

## Quick start (this repo)

```bash
npm install
npm run dev        # Astro dev server, one page per material
npm run build      # shader check + static build
npm run check      # GLSL uniform check only
npm run wasm       # rebuild the goo wasm crate (needs Rust)
```

## Using it in your app

The full consumer bootstrap (bundler requirements, SSR, canvas layering,
verification) is in [INSTALL.md](./INSTALL.md). Minimal version:

```html
<!-- any element you want to grow on; [data-bio] / .bio is the substrate -->
<div class="card" data-bio="spikes" data-bio-group="hero" data-bio-mode="active">
  …
</div>
```

```ts
import { createBio } from '@biomorphic/ca-core';
import { materials as flora } from '@biomorphic/ca-flora';
import { materials as goo } from '@biomorphic/ca-goo';

const bio = createBio({
  materials: { ...flora, ...goo },  // compose the families you ship
  material: 'spikes',
});

bio.scan();                        // register every [data-bio], .bio element
```

Runtime API:

- `bio.register(el, { group?, mode?, material? })` / `bio.unregister(el)`
- `bio.setMode(el, 'active' | 'wall' | 'emitter')` — source, inert obstacle, or
  source-that-doesn't-block (goo)
- `bio.setMaterial('tree')` — swap the page material
- `bio.reset()` / `bio.wake()` / `bio.resize()`

Materials expose their knobs as params on the engine:

```ts
const engine = bio.engine()!;
engine.params.height = 40;   // e.g. spike height
engine.wake();               // re-relax a settled sim
```

Markup conventions: `data-bio` selects the material, `data-bio-group` opts an
element into coupling (default is one group per element), and `data-bio-mode` is
`active` / `wall` / `emitter`.

## Plan / status

Shipped and working: spikes, tree, goo, the shared engine + runtime, substrate
modes, neighbour collision, reflow isolation, and the demo app.

Next up (design notes): generative frame shapes:

- Markov-chain frame shapes. Learn the chaining of frame segments and corners
  from a dump of SVG frames, then walk a Markov chain to emit new border
  topologies (corner → segment → corner …). Turns a rectangle into a family of
  plausible frame silhouettes.
- Bézier path frames. Place anchors at the outer corners of the furthest
  text boxes and fit a smooth path through them — giving sleek, curvy enclosing
  shapes (the old-mobile-phone silhouette) instead of axis-aligned rectangles.

## Install

Not on the npm registry yet; install from GitHub. See [INSTALL.md](./INSTALL.md)
for the complete agent-oriented bootstrap (bundler requirements, SSR, layering,
verification, troubleshooting).

```bash
npm i github:MitPitt/biomorphic-ui
```

That pulls the repo and its three packages, which are wired together as `file:`
links inside the repo (`@biomorphic/ca-core`, `@biomorphic/ca-flora`, `@biomorphic/ca-goo`). Then
import them as usual:

```ts
import { createBio } from '@biomorphic/ca-core';
import { materials as flora } from '@biomorphic/ca-flora';
import { materials as goo } from '@biomorphic/ca-goo';
```

### Pin a revision

This project is still evolving and may introduce breaking changes, so pin an
exact revision and bump it deliberately:

```bash
npm i github:MitPitt/biomorphic-ui#<commit-sha>
```

## Layout

```
src/                      Astro demo app (one page per material)
packages/ca-core/         engine, runtime, shapes, fields, glsl, types
packages/ca-flora/        spikes, tree
packages/ca-goo/          goo (wgsl + wasm + crates/goo)
AGENTS.md                 architecture + design decisions
```