import type { MaterialRegistry } from '@biomorphic/ca-core';
import { materials as flora } from '@biomorphic/ca-flora';
import { materials as goo } from '@biomorphic/ca-goo';

/** The material set the demo app exposes (compose whichever families you ship). */
export const materials: MaterialRegistry = { ...flora, ...goo };
