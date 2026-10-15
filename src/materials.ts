import type { MaterialRegistry } from '@bio/ca-core';
import { materials as flora } from '@bio/ca-flora';
import { materials as goo } from '@bio/ca-goo';

/** The material set the demo app exposes (compose whichever families you ship). */
export const materials: MaterialRegistry = { ...flora, ...goo };
