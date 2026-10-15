# Biomorphic UI

Hand-engineered growth rules that *look* biological, rendered as borders and
frames on ordinary DOM elements.

The idea: a web UI is made of boxes, and a box is really just a frame. Instead of
styling that frame with a static `border`, this library grows it — with cellular
automata and agent simulations that read as plausible organic matter (spikes,
trees, fluid) while still respecting the box's geometry. Growth is seeded from an
element's edges, blocked by its neighbours, and it settles into a stable shape
instead of running forever.

It is deliberately **not** a scientific simulator. Each rule is tuned to look
good on UI-scale rectangles at 60fps.

## The three rule families

| Material | What it is | How it runs |
| --- | --- | --- |
| **spikes** | A reach-field CA: stalagmite/cone tissue grown outward from the substrate rim. | WebGL2 fragment shader |
| **tree** | Space colonization (Runions): roots anchor on edges, limbs reach for attractors, optional fern-like leaves. | live CPU |
| **goo** | A position-based particle fluid that pools, drips and clings to edges. | live WebGPU (wasm fallback) |

Pick one material per page; each page's elements share that material.

## Packages

An npm-workspaces monorepo. Packages ship raw TypeScript source and are aliased
straight to `src/` (no package build step), so consume them through a
TS-capable bundler (Vite, esbuild, Astro) and add matching path aliases.

| Package | Contents |
| --- | --- |
| `@bio/ca-core` | Engine, runtime (`createBio`), shapes, fields, GLSL, types. No materials. |
| `@bio/ca-flora` | `spikes` + `tree` (substrate growth, no wasm/GPU). |
| `@bio/ca-goo` | `goo` (WGSL + wasm + `crates/goo`). |
| `src/` | The Astro demo app — one page per material. |

## Quick start (this repo)

```bash
npm install
npm run dev        # Astro dev server, one page per material
npm run build      # shader check + static build
npm run check      # GLSL uniform check only
npm run wasm       # rebuild the goo wasm crate (needs Rust)
```

## Using it in your app

```html
<!-- any element you want to grow on; .sub / [data-bio] is the substrate -->
<div class="card" data-bio="spikes" data-bio-group="hero" data-bio-mode="active">
  …
</div>
```

```ts
import { createBio } from '@bio/ca-core';
import { materials as flora } from '@bio/ca-flora';
import { materials as goo } from '@bio/ca-goo';

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
modes, neighbour collision, reflow isolation, and the demo app. It is rough but
usable as a package for existing apps — the demo is a harness, not the product.

Next up (design notes): **generative frame shapes** — replacing "a box with
growth on it" with frames that are *themselves* grown:

- **Markov-chain frame shapes.** Learn the chaining of frame segments and corners
  from a dump of SVG frames, then walk a Markov chain to emit new border
  topologies (corner → segment → corner …). Turns a rectangle into a family of
  plausible frame silhouettes.
- **Bézier path frames.** Place anchors at the outer corners of the furthest
  text boxes and fit a smooth path through them — giving sleek, curvy enclosing
  shapes (the old-mobile-phone silhouette) instead of axis-aligned rectangles.

Both are expected to arrive *later*; the current build ships as-is.

## Hosting & publishing

Yes — GitHub covers both halves, and they are complementary:

- **Code**: push the repo to GitHub as normal (public or private).
- **Package**: GitHub does not serve an npm registry from your repo, so publish
  the packages separately:
  - **npm** (public) — the usual route: `npm publish` from each workspace.
    Note the packages currently export raw `.ts` (`"exports": "./src/index.ts"`),
    so before publishing you'd add a compile step (emit `.js` + `.d.ts`) and
    point `exports`/`types` at the build output, or publish to a private registry
    and keep alias-consuming through a TS bundler.
  - **GitHub Packages** — publish to GitHub's npm registry instead (set
    `publishConfig.registry` to `https://npm.pkg.github.com`), which keeps code
    and packages under one account.
  - Alternatively, **install straight from git**: `npm i github:you/biomorphic-ui`
    or a workspace/submodule, if you don't want to publish at all.

## Layout

```
src/                      Astro demo app (one page per material)
packages/ca-core/         engine, runtime, shapes, fields, glsl, types
packages/ca-flora/        spikes, tree
packages/ca-goo/          goo (wgsl + wasm + crates/goo)
AGENTS.md                 architecture + design decisions
```