import type { Material, TargetSpec, UpsampleMode } from './types';

/** Main-thread scene options shared by the engine facade. */
export interface EngineOptions {
	/** Sim steps per frame for this engine; defaults to the material's `speed`. */
	speed?: number;
	/** Elements to rasterize on each reset, with their activity mode. */
	targets?: () => TargetSpec[];
	/**
	 * Elements owned by OTHER groups: rasterized as inert obstacles only (never
	 * sources), so an independent group's growth stops at a neighbour instead of
	 * overlapping it. Sampled at reset; a neighbour moving never rebuilds this
	 * group, so the obstacle set is a snapshot until this group next resets.
	 */
	obstacles?: () => HTMLElement[];
	/**
	 * Cross-group separation, in CSS px. When a *foreign* group's element (or live
	 * tissue) is used as a collider here, it is grown by this much, so this group
	 * keeps a gap from its neighbours instead of touching them (crown shyness).
	 * Never applied to the group's *own* elements, so it doesn't change this group's
	 * own behaviour. 0 (default) = collide at the exact boundary.
	 */
	neighborAura?: number;
	/**
	 * Upper bound on the state grid's cells (default 4M). The canvas covers the whole
	 * document, so a very small `cellSize` would otherwise allocate a huge grid; this
	 * caps it (raising the effective minimum cell). Lower it to trade detail for
	 * memory/CPU/GPU cost — every reset, seed, field, upload and sim step scales with
	 * the cell count, so this is the master perf lever.
	 */
	maxCells?: number;
	/** Deterministic RNG seed (the worker owns the generator). */
	seed?: number;
	/** Shared live-tissue namespace: engines with the same bioId in one worker share it. */
	bioId?: string;
	/** This group's token within the shared tissue map (`0` = none). */
	token?: number;
	/** Whether independent groups avoid each other's live tissue (tree crown shyness). */
	collideNeighbors?: boolean;
}

/**
 * The engine surface the runtime and demo use. Implemented by
 * `OffscreenEngine`: DOM measurement on the main thread, GL/sim in a worker.
 */
export interface BioEngine {
	readonly canvas: HTMLCanvasElement;
	readonly material: Material;
	readonly params: Record<string, number>;
	speed: number;
	seedChance: number;
	cellSize: number;
	maxCells: number;
	neighborAura: number;
	playing: boolean;
	instant: boolean;
	readonly upsampleMode: UpsampleMode;
	readonly settled: boolean;
	readonly frozen: boolean;
	readonly manualFrozen: boolean;
	reset(): void;
	resize(): void;
	refit(): boolean;
	refreshActivity(): void;
	wake(): void;
	freeze(): void;
	unfreeze(): void;
	translateBy(dx: number, dy: number): void;
	stepOnce(): void;
	settleNow(): void;
	setUpsample(mode: UpsampleMode): void;
	setMaterial(material: Material): void;
	dispose(): void;
}
