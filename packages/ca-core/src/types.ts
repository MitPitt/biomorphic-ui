export interface ParamDef {
	key: string;
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	/** True if changing this param requires a reset (field / seed rebuild). */
	reset?: boolean;
	/** Which rule family this knob belongs to (controls slider colour). */
	kind?: 'structure' | 'cells' | 'look' | 'global';
}

/**
 * A collapsible group of params in the demo control panel. Lets a material
 * present each of its rules (each CA / growth stage) as its own section, so
 * equal-but-independent automata are shown side by side.
 */
export interface ParamSection {
	id: string;
	label: string;
	/** Param keys rendered in this section, in order. */
	keys: string[];
	/**
	 * Param keys pinned to a fixed value and hidden from the UI (e.g. a demo
	 * forcing a rule into one mode). Applied once when the section is built.
	 */
	fixed?: Record<string, number>;
	/** Whether the section starts expanded (default true). */
	open?: boolean;
}

/**
 * How a registered element participates in a reset:
 * - `active` (both) — substrate obstacle **and** a growth source (seeds spikes /
 *   roots the tree / emits goo).
 * - `wall` — an inert obstacle: blocks and collides, but originates nothing.
 * - `emitter` — a source that does **not** block: goo spawned on its rim falls
 *   straight through it. Only emitting materials (goo) act on it.
 */
export type ActivityMode = 'active' | 'wall' | 'emitter';

/** One element registered as substrate for a reset, with its activity mode. */
export interface TargetSpec {
	el: HTMLElement;
	mode: ActivityMode;
}

/**
 * A document-wide, grid-aligned map of which group's **live tissue** occupies each
 * cell (`0` = free). One instance is shared by every group's engine, so independent
 * *live* CPU sims can refuse to grow through each other's tissue — not just through
 * each other's substrate boxes. This is what stops long-range growers (tree) from
 * crossing a neighbour's branches; a box obstacle alone can't, because at reset the
 * neighbour has no branches yet.
 *
 * Only live CPU materials publish here (tree). Shader sims (spikes) stay box-only:
 * their tissue lives on the GPU and reading it back per tick isn't worth it.
 */
export interface Occupancy {
	w: number;
	h: number;
	/** Group token per cell (`0` = free). A writer sets its cells to its own token. */
	owner: Int32Array;
}

export interface SeedCtx {
	w: number;
	h: number;
	/** 1 where a UI box is a frozen SUBSTRATE cell. Index = gy * w + gx, gy grows upward. */
	substrate: Uint8Array;
	/**
	 * 1 where a substrate cell is an ACTIVE growth source (an emitting/seeding box).
	 * Not necessarily a subset of `substrate`: an `emitter`-mode element is a source
	 * that does not block (goo falls through it). Materials that need a source *with*
	 * a shape intersect this with `substrate` themselves.
	 */
	active: Uint8Array;
	/**
	 * Substrate from THIS group's own elements only — foreign-group obstacles
	 * excluded. Use it for anything that must be *rendered* as this group's own box,
	 * so a settled group can translate rigidly (see `OffscreenEngine.translateBy`) without
	 * dragging copies of its neighbours along. `substrate` above still includes
	 * foreign obstacles for blocking/collision.
	 */
	ownSubstrate?: Uint8Array;
	seedChance: number;
	params: Record<string, number>;
	rand: () => number;
	/**
	 * Shared live-tissue map (absent for a standalone engine). Live materials claim
	 * the cells they grow and must not enter cells owned by another token; see
	 * `Occupancy`. `token` is this group's id within it (`0` = no sharing).
	 */
	occupancy?: Occupancy;
	token?: number;
	/**
	 * Cross-group separation in grid cells (from `createBio`'s px `neighborAura`):
	 * live materials should keep this many cells clear of *foreign* tissue, so
	 * neighbours leave a gap instead of touching (crown shyness). Own tissue is
	 * never affected. 0 = no aura.
	 */
	neighborAura?: number;
}

export interface LivePatch {
	x: number;
	y: number;
	w: number;
	h: number;
	data: Float32Array;
}

/** A static field at its own (possibly lower) resolution; see `Material.field`. */
export interface FieldData {
	data: Float32Array;
	w: number;
	h: number;
}

/**
 * How the resolve texture is upsampled to the canvas — a rendering choice only
 * (the sim is unaffected). `linear` = hardware smooth; `nearest` = grid pixels
 * (crisp); `cubic` = Catmull-Rom (sharper than linear, mild ringing); `lanczos`
 * = Lanczos-3 (sharpest, more ringing). `cubic`/`lanczos` are reconstructed in
 * the blit shader (WebGL hardware filtering only offers NEAREST/LINEAR).
 */
export type UpsampleMode = 'linear' | 'nearest' | 'cubic' | 'lanczos';

export interface LiveHandle {
	tick(): LivePatch | null;
	/**
	 * Optional: swap the substrate + source masks in place, without a full reset,
	 * when an element changes between `active` / `emitter` / `wall`. The backend
	 * updates its collision field and emitter set itself; the sim state survives, so
	 * a mode flip is a continuous flow rather than a restart. Backends without it
	 * fall back to a reset.
	 */
	setMasks?(substrate: Uint8Array, active: Uint8Array): void;
	/** Optional: release backend resources (GPU buffers/device, wasm sim). */
	dispose?(): void;
}

export interface Material {
	id: string;
	name: string;
	/**
	 * True for materials that are one physical field and cannot be per-element
	 * (goo: a single fluid). The runtime then puts every target into ONE group so
	 * the material sees all elements at once, instead of one instance per group.
	 */
	coupled?: boolean;
	/**
	 * True if this live material reads/claims the runtime's shared live-tissue
	 * `Occupancy` (tree). Only such materials cause the document-grid map to be
	 * allocated and scanned, so shader sims (spikes) and coupled goo don't pay for
	 * it. See `Occupancy` / `SeedCtx.occupancy`.
	 */
	usesOccupancy?: boolean;
	/** Fragment shader for one simulation tick. Reads u_state, writes next state. */
	sim: string;
	/** Fragment shader that maps state -> RGBA for display (crisp, at sim resolution). */
	resolve: string;
	/**
	 * True when the resolve shader animates from `u_frame` for these params (e.g.
	 * the liquid-metal flow). A settled static field then stops being re-resolved
	 * and re-blitted every frame; an animated look keeps rendering.
	 */
	animated?(params: Record<string, number>): boolean;
	params: ParamDef[];
	/**
	 * Optional grouping of `params` into collapsible sections in the demo panel.
	 * When present, the panel renders one `<details>` per section; keys not listed
	 * fall through to a trailing section.
	 */
	sections?: ParamSection[];
	/**
	 * Upper bound, in sim ticks, after which a shader sim is considered settled:
	 * the engine stops stepping it to avoid wasting GPU/CPU until a param change
	 * wakes it. Omit for materials that never settle on their own. Live materials
	 * settle automatically (stepping stops once `tick` returns nulls).
	 */
	settle?(params: Record<string, number>): number;
	speed?: number;
	/** Builds the initial RGBA state (type, age, heading/density, aux). */
	seed?(ctx: SeedCtx): Float32Array;
	/**
	 * Optional static 2-channel (nx, ny) field uploaded as `u_field`, sampled with
	 * LINEAR. Return a bare `Float32Array` for a full-grid field, or `{data,w,h}` to
	 * provide it at lower resolution (a smooth direction field rarely needs full res).
	 */
	field?(ctx: SeedCtx): Float32Array | FieldData;
	/**
	 * Optional CPU-driven live sim: `start` returns the initial full state and a
	 * handle whose `tick` returns a sub-rectangle patch each frame. The engine
	 * uploads patches via texSubImage2D. Used for algorithms (space colonization)
	 * that can't run as a local shader.
	 */
	live?: {
		start(ctx: SeedCtx): { initial: Float32Array; handle: LiveHandle };
		/**
		 * True if `tick` eventually returns null because the algorithm has
		 * *finished* (e.g. Runions). The engine then stops ticking it once settled.
		 * Omit for open-ended sims (e.g. goo) where null can mean "not ready yet"
		 * or "no change this frame" — those are never auto-frozen.
		 */
		finite?: boolean;
	};
	}

/** A material set the app composes and hands to `createBio`. */
export type MaterialRegistry = Record<string, Material>;

/** Cell type codes. Shared by every material and by the shaders. */
export const T = {
	EMPTY: 0,
	SUBSTRATE: 1,
	GOO: 2,
	SPIKE: 3,
} as const;

/** 8-neighbourhood offsets, index order matches the shaders (0 = +x, CCW). */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
	[1, 0],
	[1, 1],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[-1, -1],
	[0, -1],
	[1, -1],
];

export function headingFromVector(x: number, y: number): number {
	const a = Math.atan2(y, x);
	let i = Math.round(a / (Math.PI / 4));
	i = ((i % 8) + 8) % 8;
	return i;
}
