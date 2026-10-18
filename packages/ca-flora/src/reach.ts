/**
 * Reach-field growth stencil.
 *
 * The spikes/crevice reach field is a max-plus field propagated one grid step
 * at a time, so its growth direction can only be one of the step directions.
 * With the bare 8-neighbourhood the tip of a spike therefore snaps to the 8
 * lattice rays (multiples of 45°), even when the driving normal is arbitrary.
 *
 * Adding concentric shells of longer offsets (the "knight" moves and beyond)
 * fills in the intermediate rays: the tip granularity drops from 45° to
 * ~atan(1/maxR). The offsets are ordered by squared length so that any prefix
 * is a symmetric, complete shell; `snapDirs` clamps a requested count down to
 * the nearest complete shell. The Spikes shader regenerates the same set
 * arithmetically (`dx*dx+dy*dy <= cutoff`) instead of indexing a const array,
 * which some mobile GLES drivers miscompile.
 *
 * Shell counts: 8 (r1) → 12 (r2 axis) → 20 (knight) → 24 (r2 diag) →
 * 28 (r3 axis) → 36 (3,1) → 44 (3,2) → 48 (r4 axis).
 */

function buildOffsets(maxR: number): Array<[number, number]> {
	const all: Array<[number, number]> = [];
	for (let dx = -maxR; dx <= maxR; dx++) {
		for (let dy = -maxR; dy <= maxR; dy++) {
			const d2 = dx * dx + dy * dy;
			if (d2 === 0 || d2 > maxR * maxR) continue;
			all.push([dx, dy]);
		}
	}
	all.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
	return all;
}

export const MAX_REACH_R = 4;
export const REACH_OFFSETS: ReadonlyArray<readonly [number, number]> = buildOffsets(MAX_REACH_R);
const SHELLS = [8, 12, 20, 24, 28, 36, 44, 48];

/** Clamp a requested direction count down to the nearest complete shell. */
export function snapDirs(n: number): number {
	for (const s of SHELLS) if (n <= s) return s;
	return SHELLS[SHELLS.length - 1];
}
