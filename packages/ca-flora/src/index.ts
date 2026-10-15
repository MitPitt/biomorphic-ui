/**
 * @bio/ca-flora — the growth-from-substrate material family: `spikes` (a shader
 * reach-field CA) and `tree` (live space colonization). No wasm / GPU compute;
 * runs on the shared WebGL2 engine from `@bio/ca-core`.
 */

import type { Material, MaterialRegistry } from '@bio/ca-core';
import { spikes } from './spikes';
import { tree } from './tree';

export const materials: MaterialRegistry = { spikes, tree };
export type { Material };

export { spikes } from './spikes';
export { tree } from './tree';
