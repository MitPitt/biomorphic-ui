import type { GridLayout, RasterScene } from './scene';
import type { UpsampleMode } from './types';

/** Messages the main thread sends to the bio worker. */
export type WorkerRequest =
	| { t: 'hello'; id: string }
	| {
			t: 'create';
			id: string;
			material: string;
			canvas: OffscreenCanvas;
			grid: GridLayout;
			params: Record<string, number>;
			speed: number;
			instant: boolean;
			upsample: UpsampleMode;
			neighborAura: number;
			seed: number;
			bioId: string;
			token: number;
			collideNeighbors: boolean;
	  }
	| {
			t: 'reset';
			id: string;
			grid: GridLayout;
			scene: RasterScene;
			params: Record<string, number>;
			speed: number;
			instant: boolean;
			upsample: UpsampleMode;
			seedChance: number;
			neighborAura: number;
	  }
	| { t: 'fit'; id: string; grid: GridLayout }
	| { t: 'refresh'; id: string; grid: GridLayout; scene: RasterScene; params: Record<string, number> }
	| { t: 'wake'; id: string; params: Record<string, number>; speed: number; instant: boolean }
	| { t: 'freeze'; id: string }
	| { t: 'unfreeze'; id: string; params: Record<string, number>; instant: boolean }
	| { t: 'speed'; id: string; speed: number }
	| { t: 'playing'; id: string; playing: boolean }
	| { t: 'instant'; id: string; instant: boolean }
	| { t: 'step'; id: string; params: Record<string, number> }
	| { t: 'settle'; id: string; params: Record<string, number>; instant: boolean }
	| { t: 'upsample'; id: string; mode: UpsampleMode }
	| {
			t: 'setMaterial';
			id: string;
			material: string;
			bioId: string;
			token: number;
			collideNeighbors: boolean;
	  }
	| { t: 'dispose'; id: string };

/** Messages the bio worker sends back. */
export type WorkerResponse =
	| { t: 'ready'; id: string; maxTextureSize: number }
	| { t: 'status'; id: string; settled: boolean }
	| { t: 'error'; id: string; message: string };
