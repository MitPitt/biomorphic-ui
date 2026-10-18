# Installing Biomorphic UI in another app

> **If you are an agent:** this file is the complete bootstrap. Do not clone this
> repo, run its build, or read `AGENTS.md` to install it. `AGENTS.md` describes
> the library's internals for contributors; it is not install documentation.

Biomorphic UI is a framework-agnostic TypeScript library: it appends one
transparent WebGL2 canvas to the page and grows borders/frames from the DOM
elements you mark as substrate. There is no React/Vue/Svelte wrapper, no
provider, and no CSS file to import; you call `createBio()` once.

## Requirements

| Requirement | Notes |
| --- | --- |
| Bundler | A Vite-based app (Astro, SvelteKit, Nuxt, Remix+Vite, plain Vite). The goo package uses Vite asset imports (`?url`, `?raw`). |
| Browser | WebGL2. `goo` additionally uses WebGPU when available, with a wasm fallback. Use `https` or `localhost` (secure context). |
| Node | 22.12+ for the library repo's own tooling. Your app only needs a Vite version that supports its own Node. |
| Rust | Not needed. The compiled `goo.wasm` is committed and shipped. |

Not on the npm registry yet: install from GitHub and pin a revision.

## 1. Install

```bash
npm i github:MitPitt/biomorphic-ui#<commit-sha>
```

Get the current SHA without cloning:

```bash
git ls-remote https://github.com/MitPitt/biomorphic-ui HEAD
```

npm installs the monorepo with its three workspace packages linked as
`node_modules/@biomorphic/ca-core`, `ca-flora`, and `ca-goo`. Import those
package names; no path aliases are needed with Vite. Do not import deep paths
such as `@biomorphic/ca-core/src/engine`.

Pinning matters: the API is still moving. Bump the SHA deliberately, then
rebuild and re-run the checks below.

## 2. Mark substrate elements in markup

```html
<div class="card" data-bio="spikes" data-bio-mode="active">
  <h2>Card</h2>
  <p>Growth starts at this element's rim.</p>
</div>
```

- `data-bio` — material id: `spikes`, `tree`, or `goo`. Use one material per
  page.
- `data-bio-mode` — optional, defaults to `active`:
  - `active`: seeds/emits **and** blocks (the normal case).
  - `wall`: inert obstacle only.
  - `emitter`: source only, does not block. Only `goo` emits from it.
- `data-bio-group` — optional; elements sharing this id share one automaton.
  Omit it and every element is independent.
- `data-shape` — optional substrate outline: `rect` (default), `circle`,
  `polygon`, `star`, or `text`. `text` uses the element's real rendered glyphs
  (its CSS font, wrapping, and `text-transform`) as the substrate, so growth
  starts at letter edges instead of the box:

```html
<h1 data-bio="spikes" data-shape="text">spikes</h1>
```

With `spikes`, the `inset` param (CSS px; also a slider in the demo) offsets the
substrate: positive pulls it inward, hiding the spike bases behind the glyph
ink, negative pushes it outward. Text strokes have to be thick enough to survive
a large inset.

`scan()` registers `[data-bio], .bio` by default. You can also call
`bio.register(el, { material, group, mode })` yourself.

## 3. Bootstrap from client-side code

Every material runs in a worker on an OffscreenCanvas. Create a worker entry that
imports the same registry:

```ts
// bio.worker.ts
import { startBioWorker } from '@biomorphic/ca-core';
import { materials } from './materials';
startBioWorker(materials);
```

```ts
import { createBio } from '@biomorphic/ca-core';
import { materials as flora } from '@biomorphic/ca-flora';
import { materials as goo } from '@biomorphic/ca-goo';

const bio = createBio({
  materials: { ...flora, ...goo }, // drop goo if you do not ship it
  material: 'spikes',
  seed: 1,
  worker: () => new Worker(new URL('./bio.worker.ts', import.meta.url), { type: 'module' }),
});

bio.scan(); // register every [data-bio], .bio on the page
```

The factory may be called more than once (the runtime pools workers, at most 4
WebGL contexts each). Tree groups share one worker so their cross-group occupancy
map is shared. Browsers without `transferControlToOffscreen` are not supported.

If you only use `spikes`/`tree`, import only `@biomorphic/ca-flora`; that
avoids loading the goo backend and its wasm asset.

**SSR:** importing the packages is safe, but `createBio()`/`scan()` touch the
DOM and must run in the browser:

- Astro: a normal `<script>` (processed by Vite)
- Svelte: `onMount`
- Vue: `onMounted`
- React: `useEffect`

Tear down in the same lifecycle (`bio.destroy()`), including HMR/unmount paths,
so canvases and animation loops do not accumulate:

```ts
const bio = createBio({
	materials: flora,
	material: 'spikes',
	worker: () => new Worker(new URL('./bio.worker.ts', import.meta.url), { type: 'module' }),
});
bio.scan();
return () => bio.destroy();
```

## 4. Give the canvas a layer

The runtime appends an absolutely positioned, `pointer-events: none` canvas to
`document.body` at `z-index: 0`. Put page content above it:

```css
main {
  position: relative;
  z-index: 1;
}
```

Do not pin `html, body { height: 100% }` and avoid putting targets inside an
inner scrolling container: the canvas is document-sized and the runtime tracks
document coordinates. Normal document flow (the page scrolls) is the supported
layout.

## 5. Tune (optional)

```ts
const engine = bio.engine();
if (engine) {
  engine.params.height = 40; // key depends on the material
  engine.wake();             // re-relax a settled shape
}
```

`engine.material.params` lists the keys, ranges, and labels for that material.
Runtime-wide knobs: `engine.speed`, `engine.cellSize`, and
`createBio({ cellBudget })` (grid cap per group; lower it for speed/memory).

Other runtime calls: `setMaterial`, `setMode`, `reset`, `wake`, `resize`,
`freeze`, `unfreeze`, `unregister`. See README.md for the full API.

## Verify the install

1. `npm run build` (or your app's build) succeeds with no unresolved
   `goo.wasm?url` / `goo.wgsl?raw` imports.
2. No `document is not defined` at build/SSR time.
3. In the browser, `document.querySelector('canvas[data-bio-canvas]')` exists
   and growth is visible above the target.
4. For goo, check the console for `[goo] failed to load wasm`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Failed to resolve import "./goo.wasm?url"` or `?raw` | Bundler is not Vite-based. Use Vite/Astro, or import only `@biomorphic/ca-flora` (no goo). |
| `document is not defined` | `createBio()`/`scan()` ran during SSR. Move it to a client-only lifecycle. |
| Nothing visible | Content is painted under the canvas, or the target has no area. Add `position: relative; z-index: 1` to the content layer and give targets layout. |
| Growth is clipped or detached after a reflow | Update to a current revision; the canvas re-fits on every rebuild. Avoid fixed-height/fixed-position page roots and inner scrollers. |
| `WebGL2 is not available` | Browser/environment lacks WebGL2 (headless, disabled GPU). Use a supported browser. |
| Goo does not move | Goo needs `data-bio-mode="active"` (or `emitter`) to have a source. It is one coupled fluid per page and never auto-settles; check WebGPU or the wasm fallback. |
| TypeScript cannot resolve `@biomorphic/*` | Set `"moduleResolution": "bundler"` in your tsconfig. Vite builds fine without aliases; add `paths` only for your editor/type-checker. |
| Multiple growths overlap | Give independent elements their own groups (default) and leave `collideNeighbors` on; use `data-bio-group` only when you want elements coupled. |

## Do not

- Do not clone the repo, `npm install` inside it, or run `npm run build` in the
  installed package. The packages ship TypeScript source; Vite transpiles it.
- Do not read `AGENTS.md` for installation. Read it only when modifying this
  library.
- Do not mix materials on one page (one material id per page is the convention).
- Do not use Next.js/webpack/Turbopack with goo without replacing its Vite asset
  imports; only the Vite path is supported today.

## Where to read more

- `README.md` — overview, material table, runtime API, markup conventions.
- `AGENTS.md` — contributor architecture and design decisions (not needed to
  consume the library).
- `packages/*/AGENTS.md` — internals for spikes/tree and goo.
