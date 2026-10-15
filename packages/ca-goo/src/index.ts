/**
 * @bio/ca-goo — the liquid material family: a single position-based fluid, on the
 * WebGPU compute backend (preferred) with a wasm fallback (`crates/goo`). It is
 * `coupled`: the runtime keeps every target in one group, so goo is one fluid.
 */

import type { MaterialRegistry } from '@bio/ca-core';
import { goo } from './goo';

export const materials: MaterialRegistry = { goo };

export { goo } from './goo';
