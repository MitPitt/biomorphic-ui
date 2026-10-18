import type { BioEngine } from './engine-api';
import { canUseOffscreen, OffscreenEngine } from './offscreen';
import type { ActivityMode, Material, MaterialRegistry, UpsampleMode } from './types';

/**
 * createBio — the framework-agnostic runtime.
 *
 * Owns one worker-backed `OffscreenEngine` **per group** and a registry of the
 * elements that seed each group's field. A "group" is the set of elements whose growth is intentionally
 * coupled into one simulation grid (e.g. the goo fluid, or a crevice pair). Two
 * elements that must not couple — and must survive each other's reflow — belong to
 * different groups, so moving one never rebuilds the other.
 *
 * Why groups: a CA field is only valid while every substrate cell rasterized into
 * it keeps the same grid coordinate. A window resize, an element that resizes, an
 * element that *translates* (pushed by content above), or any group member's
 * reflow invalidates the group's field, so the runtime rebuilds that group. An
 * unrelated element's reflow costs nothing. Rebuilds are deterministic (seeded
 * RNG), so an unchanged layout regrows identically and a change looks like a clean
 * re-grow, not a different plant.
 *
 * Reflow detection is rect-diffing, not just ResizeObserver: position changes
 * (translation) do not fire ResizeObserver, so a target observer plus a
 * document-level observer both trigger a diff of *document* rects and rebuild only
 * the groups whose own rects actually moved.
 *
 * Dev-UX: register a target (or let `scan` do it) — a class/attribute on a div:
 *   <div class="bio" data-bio="tree" data-bio-group="hero" data-bio-mode="active">
 * `data-bio` selects the material, `data-bio-group` couples elements, and
 * `data-bio-mode` is `active` (seeds/emits) or `wall` (inert obstacle).
 */

export interface CreateBioOptions {
	/** The material set this runtime can use; the app composes it (e.g. flora + goo). */
	materials: MaterialRegistry;
	/** Default material id for groups that don't name one; defaults the first registry key. */
	material?: string;
	/** Base seed; each group derives a stable sub-seed so rebuilds reproduce. */
	seed?: number;
	/** Params applied to every group's engine on creation. */
	params?: Record<string, number>;
	/** Sim steps per frame for every group; defaults to the material's `speed`. */
	speed?: number;
	/** Base cell size in CSS px (the cell budget may raise it); default 4. */
	cellSize?: number;
	/** How the resolve texture is upsampled to the canvas (look-only, default `linear`). */
	upsample?: UpsampleMode;
	/** Selector scanned by `scan()`; defaults to `[data-bio], .bio`. */
	selector?: string;
	/** Group the no-arg `engine()`/`setMaterial()` target; defaults the first registered. */
	primary?: string;
	/**
	 * Make every independent group treat the *other* groups' elements as inert
	 * obstacles (substrate, never sources). Close groups then read as one logical
	 * mass without coupling their fields — a neighbour's reflow still never
	 * rebuilds this group, since obstacles are only sampled when this group
	 * resets. Default true; set false for fully blind, pairwise-overlapping groups.
	 */
	collideNeighbors?: boolean;
	/**
	 * Cross-group separation, in CSS px. A group's box (and live tissue) is grown by
	 * this much when *other* groups use it as a collider, so neighbours keep a gap
	 * instead of touching (crown shyness). Purely cross-group: a group's own growth
	 * is unaffected. 0 = collide at the boundary.
	 */
	neighborAura?: number;
	/**
	 * Upper bound on each group's grid cells (default 4M). Small `cellSize` settings
	 * would otherwise allocate a huge per-group grid; this caps it and raises the
	 * effective minimum cell. Lower it to trade sim detail for speed/memory.
	 */
	cellBudget?: number;
	/**
	 * Worker factory. Every material (shader or live) runs in a worker on an
	 * OffscreenCanvas, so the page's main thread only measures rects and glyph
	 * masks. The factory may be called several times (a worker holds at most a few
	 * WebGL contexts) and must bundle `startBioWorker` with the same material
	 * registry. Required: browsers without `transferControlToOffscreen` are not
	 * supported.
	 */
	worker: () => Worker | null;
}

export interface RegisterOptions {
	group?: string;
	mode?: ActivityMode;
	material?: string;
}

export interface Bio {
	/** The engine backing a group (default group when omitted). */
	engine(group?: string): BioEngine | undefined;
	/** Group ids currently alive. */
	groups(): string[];
	/** Register an element as substrate for a group (creates the group on demand). */
	register(el: HTMLElement, opts?: RegisterOptions): void;
	/** Stop tracking an element (its group is rebuilt without it). */
	unregister(el: HTMLElement): void;
	/** Flip an element between active (seeds) and wall (inert obstacle). */
	setMode(el: HTMLElement, mode: ActivityMode): void;
	/** Swap a group's material. */
	setMaterial(id: string, group?: string): void;
	/** Rebuild a group's field from the current layout. */
	reset(group?: string): void;
	/** Wake a settled group so it relaxes again. */
	wake(group?: string): void;
	/**
	 * Hold a group's current field without advancing, and *defer* any rebuild of it:
	 * a resize or divergent move while frozen is applied on `unfreeze()`/`reset()`,
	 * so an animated reflow can be held and then re-grown once. A pure move still
	 * slides the frozen shape rigidly.
	 */
	freeze(group?: string): void;
	/**
	 * Release a manual freeze. If the group had been rigidly translated while frozen
	 * its field is stale, so it rebuilds (re-rasterizes and re-grows); otherwise it
	 * just resumes. The per-group "unfreeze so it can re-adjust" switch.
	 */
	unfreeze(group?: string): void;
	/** True while a group is manually frozen or has settled. */
	frozen(group?: string): boolean;
	/** Re-fit a group's grid to the canvas. */
	resize(group?: string): void;
	/** Register every element matching the selector under `root`. */
	scan(root?: ParentNode): void;
	/** Tear everything down. */
	destroy(): void;
}

type Rect = [number, number, number, number];

interface GroupState {
	id: string;
	engine: BioEngine;
	canvas: HTMLCanvasElement;
	targets: Map<HTMLElement, ActivityMode>;
	/** Last-seen document rect per target, for translation-aware reflow detection. */
	rects: Map<HTMLElement, Rect>;
	/** True when a change arrived while manually frozen and its rebuild was deferred. */
	dirty: boolean;
	ro: ResizeObserver | null;
	pending: number;
}

function hashStr(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h | 0;
}

/** Stable per-element group id for elements that don't name a group. */
let autoSeq = 0;
const autoIds = new WeakMap<HTMLElement, string>();
function autoId(el: HTMLElement): string {
	let id = autoIds.get(el);
	if (!id) {
		id = `element-${++autoSeq}`;
		autoIds.set(el, id);
	}
	return id;
}

/** The single group every target is merged into while a coupled material is active. */
const COUPLED_GROUP = 'coupled';

function modeOf(el: HTMLElement): ActivityMode {
	const m = el.dataset.bioMode;
	return m === 'wall' || m === 'emitter' ? m : 'active';
}

function rectOf(el: HTMLElement): Rect {
	const r = el.getBoundingClientRect();
	return [
		Math.round(r.left + window.scrollX),
		Math.round(r.top + window.scrollY),
		Math.round(r.width),
		Math.round(r.height),
	];
}

let bioSeq = 0;

export function createBio(opts: CreateBioOptions): Bio {
	if (!opts.worker) throw new Error('[bio] createBio requires a worker factory');
	if (!canUseOffscreen()) throw new Error('[bio] OffscreenCanvas + web workers are required');
	const bioId = `bio-${++bioSeq}`;
	const registry = opts.materials;
	const baseSeed = opts.seed ?? 0x1234abcd;
	const defaultMaterial = opts.material ?? Object.keys(registry)[0] ?? 'spikes';
	const selector = opts.selector ?? '[data-bio], .bio';
	const collideNeighbors = opts.collideNeighbors !== false;
	const groups = new Map<string, GroupState>();
	/** element -> group id, so unregister/setMode can find the owning group. */
	const owner = new Map<HTMLElement, string>();
	/** Group ids map to stable non-zero tokens for the worker's shared tissue map. */
	const tokens = new Map<string, number>();
	let primaryId: string | null = opts.primary ?? null;
	/** Current page-wide material (set by `setMaterial(id)` with no group). */
	let globalMaterialId = defaultMaterial;
	/** True while a coupled material (goo) is active: every target shares one group. */
	let coupled = !!registry[globalMaterialId]?.coupled;
	/** Engine globals preserved across a coupling rebuild. */
	const defaults: {
		speed?: number;
		seedChance?: number;
		cellSize?: number;
		upsample?: UpsampleMode;
	} = {};

	/** Stable non-zero token for a group id (0 is reserved for "free"). */
	const tokenFor = (id: string): number => {
		let t = tokens.get(id);
		if (t === undefined) {
			t = tokens.size + 1;
			tokens.set(id, t);
		}
		return t;
	};

	const refreshRects = (g: GroupState): void => {
		for (const el of g.targets.keys()) g.rects.set(el, rectOf(el));
	};

	/** Rebuild a group from the current layout and clear any deferred-rebuild flag. */
	const rebuild = (g: GroupState): void => {
		g.dirty = false;
		g.engine.reset();
		refreshRects(g);
	};

	type RectsMove = { kind: 'none' } | { kind: 'translate'; dx: number; dy: number } | { kind: 'rebuild' };

	/**
	 * Compare current target rects against the last-seen ones and classify the
	 * change. A *uniform pure translation* (every target keeps its size and moves by
	 * the same delta) can move a frozen (settled or manually frozen) group as one
	 * rigid piece; anything else needs a rebuild. Always updates the stored rects.
	 */
	const classify = (g: GroupState): RectsMove => {
		let dx: number | null = null;
		let dy: number | null = null;
		let changed = false;
		let rebuild = false;
		for (const el of g.targets.keys()) {
			const r = rectOf(el);
			const p = g.rects.get(el);
			g.rects.set(el, r);
			if (!p) { rebuild = true; changed = true; continue; }
			if (p[0] === r[0] && p[1] === r[1] && p[2] === r[2] && p[3] === r[3]) continue;
			changed = true;
			if (p[2] !== r[2] || p[3] !== r[3]) { rebuild = true; continue; }
			const ddx = r[0] - p[0];
			const ddy = r[1] - p[1];
			if (dx === null) { dx = ddx; dy = ddy; }
			else if (dx !== ddx || dy !== ddy) rebuild = true;   // members diverged
		}
		if (!changed) return { kind: 'none' };
		if (rebuild || dx === null || dy === null) return { kind: 'rebuild' };
		return { kind: 'translate', dx, dy };
	};

	const schedule = (g: GroupState): void => {
		if (g.pending) cancelAnimationFrame(g.pending);
		g.pending = requestAnimationFrame(() => {
			g.pending = 0;
			const m = classify(g);
			if (m.kind === 'none') return;
			// a frozen field (manually frozen or settled) is self-contained: move it as
			// one piece rather than re-growing.
			if (m.kind === 'translate' && g.engine.frozen) {
				g.engine.translateBy(m.dx, m.dy);
				return;
			}
			// a *manually* frozen group is held through any other change (a resize, or a
			// divergent move): record that a rebuild is due and defer it to
			// unfreeze()/reset(), so an animated reflow doesn't thrash the field.
			if (g.engine.manualFrozen) {
				g.dirty = true;
				return;
			}
			rebuild(g);
		});
	};

	// A single worker can only hold a few live WebGL contexts before Chrome
	// silently loses the oldest ones, so spread groups across a small pool. Live
	// tissue materials (tree) must all share ONE worker to share the occupancy
	// map, so they get a sticky worker of their own.
	const MAX_GROUPS_PER_WORKER = 4;
	const workerSlots: Array<{ worker: Worker; load: number }> = [];
	let stickyWorker: Worker | null = null;
	let stickyLoad = 0;
	const makeWorker = (): Worker => {
		const worker = opts.worker();
		if (!worker) throw new Error('[bio] worker factory returned null');
		return worker;
	};
	const getWorker = (material: Material): Worker => {
		if (material.usesOccupancy) {
			if (!stickyWorker) stickyWorker = makeWorker();
			if (++stickyLoad > MAX_GROUPS_PER_WORKER) {
				console.warn('[bio] more than 4 live-tissue groups share a worker; WebGL contexts may be lost');
			}
			return stickyWorker;
		}
		let slot = workerSlots.find((s) => s.load < MAX_GROUPS_PER_WORKER);
		if (!slot) {
			slot = { worker: makeWorker(), load: 0 };
			workerSlots.push(slot);
		}
		slot.load++;
		return slot.worker;
	};

	const ensure = (id: string, materialId?: string): GroupState => {
		const found = groups.get(id);
		if (found) return found;

		const material: Material = registry[materialId ?? defaultMaterial] ?? registry[defaultMaterial];
		const canvas = document.createElement('canvas');
		canvas.dataset.bioCanvas = id;
		canvas.style.cssText = 'position:absolute;top:0;left:0;z-index:0;pointer-events:none;';
		document.body.appendChild(canvas);

		const state: GroupState = {
			id,
			canvas,
			targets: new Map(),
			rects: new Map(),
			dirty: false,
			ro: null,
			pending: 0,
			engine: undefined as unknown as BioEngine,
		};
		const engineOpts = {
			targets: () => Array.from(state.targets, ([el, mode]) => ({ el, mode })),
			// every element owned by a *different* group is an inert obstacle here
			// (hooks into `owner`, which later gets the new element's own entry).
			obstacles: collideNeighbors
				? () => {
						const out: HTMLElement[] = [];
						for (const [el, gid] of owner) {
							if (gid === id) continue;
							const mode = groups.get(gid)?.targets.get(el) ?? modeOf(el);
							if (mode === 'emitter') continue;   // sources without shapes never block
							out.push(el);
						}
						return out;
					}
				: undefined,
			neighborAura: collideNeighbors ? (opts.neighborAura ?? 0) : 0,
			maxCells: opts.cellBudget,
			seed: (baseSeed ^ hashStr(id)) >>> 0,
			bioId,
			token: collideNeighbors ? tokenFor(id) : 0,
			collideNeighbors,
		};
		const worker = getWorker(material);
		state.engine = new OffscreenEngine(canvas, material, { ...engineOpts, worker, id });
		if (opts.params) Object.assign(state.engine.params, opts.params);
		if (opts.speed !== undefined) state.engine.speed = opts.speed;
		if (opts.cellSize !== undefined) state.engine.cellSize = opts.cellSize;
		if (opts.upsample !== undefined) state.engine.setUpsample(opts.upsample);
		if (defaults.speed !== undefined) state.engine.speed = defaults.speed;
		if (defaults.seedChance !== undefined) state.engine.seedChance = defaults.seedChance;
		if (defaults.cellSize !== undefined) state.engine.cellSize = defaults.cellSize;
		if (defaults.upsample !== undefined) state.engine.setUpsample(defaults.upsample);
		groups.set(id, state);
		if (typeof ResizeObserver !== 'undefined') {
			// size changes of a target, and (separately) any document reflow, both
			// run a rect diff so translation is caught, not just resizing.
			state.ro = new ResizeObserver(() => schedule(state));
		}
		state.engine.resize();
		return state;
	};

	const groupOf = (el: HTMLElement): GroupState | undefined => {
		const id = owner.get(el);
		return id ? groups.get(id) : undefined;
	};

	const register = (el: HTMLElement, o: RegisterOptions = {}): void => {
		if (owner.has(el)) return;
		// a coupled material (goo) ignores grouping: every target is one field
		const groupId = coupled ? COUPLED_GROUP : o.group ?? el.dataset.bioGroup ?? autoId(el);
		const mode = o.mode ?? modeOf(el);
		const materialId = coupled ? globalMaterialId : o.material ?? el.dataset.bio ?? undefined;
		const g = ensure(groupId, materialId);
		g.targets.set(el, mode);
		owner.set(el, groupId);
		g.ro?.observe(el);
		rebuild(g);
		if (!primaryId) primaryId = groupId;
	};

	const unregister = (el: HTMLElement): void => {
		const g = groupOf(el);
		if (!g) return;
		g.targets.delete(el);
		g.rects.delete(el);
		owner.delete(el);
		g.ro?.unobserve(el);
		rebuild(g);
	};

	const setMode = (el: HTMLElement, mode: ActivityMode): void => {
		const g = groupOf(el);
		if (!g || g.targets.get(el) === mode) return;
		g.targets.set(el, mode);
		el.dataset.bioMode = mode;
		g.engine.refreshActivity();
		g.dirty = false;
		refreshRects(g);
	};

	/**
	 * Rebuild the whole group layout from the current targets, preserving each
	 * element's mode and the engine globals. Used when switching to/from a coupled
	 * material: coupled => all targets merge into one group; decoupled => back to
	 * the per-element / `data-bio-group` layout.
	 */
	const rebuildLayout = (): void => {
		const specs = [...owner.keys()].map((el) => ({
			el,
			mode: groupOf(el)?.targets.get(el) ?? modeOf(el),
		}));
		for (const g of groups.values()) {
			defaults.speed ??= g.engine.speed;
			defaults.seedChance ??= g.engine.seedChance;
			defaults.cellSize ??= g.engine.cellSize;
			defaults.upsample ??= g.engine.upsampleMode;
			if (g.pending) cancelAnimationFrame(g.pending);
			g.ro?.disconnect();
			g.engine.dispose();
			g.canvas.remove();
		}
		groups.clear();
		owner.clear();
		primaryId = null;
		for (const s of specs) register(s.el, { mode: s.mode });
	};

	const setMaterial = (id: string, group?: string): void => {
		if (!registry[id]) return;
		if (group) {
			const g = groups.get(group);
			if (g) {
				g.dirty = false;
				g.engine.setMaterial(registry[id]);
				refreshRects(g);
			}
			return;
		}
		globalMaterialId = id;
		const wantCoupled = !!registry[id].coupled;
		if (wantCoupled !== coupled) {
			coupled = wantCoupled;
			rebuildLayout();
			return;
		}
		for (const g of groups.values()) {
			g.dirty = false;
			g.engine.setMaterial(registry[id]);
			refreshRects(g);
		}
	};

	const forEachGroup = (group: string | undefined, fn: (g: GroupState) => void): void => {
		if (group) {
			const g = groups.get(group);
			if (g) fn(g);
		} else {
			for (const g of groups.values()) fn(g);
		}
	};

	const scan = (root: ParentNode = document): void => {
		root.querySelectorAll<HTMLElement>(selector).forEach((el) => register(el));
		// registering happens one element at a time, so earlier groups missed the
		// later ones as obstacles; a single pass now makes the neighbourhood symmetric.
		for (const g of groups.values()) {
			rebuild(g);
		}
	};

	// Mobile URL bars/toolbars fire `resize` as they slide in and out on scroll.
	// That changes the viewport height but not the document layout, so only
	// rebuild when the fitted grid really changed (a width/orientation change),
	// never on a browser-chrome height change.
	const onWindowResize = (): void => forEachGroup(undefined, (g) => {
		if (g.engine.refit()) {
			g.dirty = false;
			// the refit already re-rasterized against the current layout; sync the
			// cached rects so the document observer's follow-up diff is a no-op
			refreshRects(g);
		}
	});
	// a document reflow (content above moves) may not resize any target individually;
	// the documentElement observer catches it, then the rect diff decides which groups
	// are actually affected.
	const docRO =
		typeof ResizeObserver !== 'undefined'
			? new ResizeObserver(() => forEachGroup(undefined, (g) => schedule(g)))
			: null;
	if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
	docRO?.observe(document.documentElement);

	return {
		engine: (group) => {
			const id = group ?? primaryId;
			return id ? groups.get(id)?.engine : undefined;
		},
		groups: () => [...groups.keys()],
		register,
		unregister,
		setMode,
		setMaterial,
		reset: (group) => forEachGroup(group, (g) => rebuild(g)),
		wake: (group) => forEachGroup(group, (g) => g.engine.wake()),
		freeze: (group) => forEachGroup(group, (g) => g.engine.freeze()),
		unfreeze: (group) => forEachGroup(group, (g) => {
			// a deferred rebuild wins: re-rasterize against the new layout instead of
			// resuming a field whose substrate is stale
			if (g.dirty) { g.dirty = false; g.engine.reset(); } else g.engine.unfreeze();
			refreshRects(g);
		}),
		frozen: (group) => {
			const id = group ?? primaryId;
			return id ? !!groups.get(id)?.engine.frozen : false;
		},
		resize: (group) => forEachGroup(group, (g) => { g.dirty = false; g.engine.resize(); }),
		scan,
		destroy: () => {
			if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
			docRO?.disconnect();
			for (const g of groups.values()) {
				if (g.pending) cancelAnimationFrame(g.pending);
				g.ro?.disconnect();
				g.engine.dispose();
				g.canvas.remove();
			}
			groups.clear();
			owner.clear();
			for (const s of workerSlots) s.worker.terminate();
			workerSlots.length = 0;
			stickyWorker?.terminate();
			stickyWorker = null;
		},
	};
}
