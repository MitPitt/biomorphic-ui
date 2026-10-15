export type ShapeKind = 'rect' | 'circle' | 'polygon' | 'star';

export interface ShapeSpec {
	kind: ShapeKind;
	sides?: number;
	points?: number;
}

export function shapeSpecOf(el: HTMLElement): ShapeSpec {
	const kind = (el.dataset.shape as ShapeKind) ?? 'rect';
	return {
		kind,
		sides: el.dataset.sides ? parseInt(el.dataset.sides, 10) : 6,
		points: el.dataset.points ? parseInt(el.dataset.points, 10) : 5,
	};
}

/** Vertices in normalised [-1,1] space, y down (matches CSS). */
function vertices(spec: ShapeSpec): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	if (spec.kind === 'polygon') {
		const n = Math.max(3, spec.sides ?? 6);
		for (let i = 0; i < n; i++) {
			const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
			out.push([Math.cos(a), Math.sin(a)]);
		}
	} else if (spec.kind === 'star') {
		const n = Math.max(3, spec.points ?? 5);
		const inner = 0.45;
		for (let i = 0; i < 2 * n; i++) {
			const r = i % 2 === 0 ? 1 : inner;
			const a = -Math.PI / 2 + (i * Math.PI) / n;
			out.push([r * Math.cos(a), r * Math.sin(a)]);
		}
	}
	return out;
}

function inPolygon(px: number, py: number, poly: Array<[number, number]>): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		const hit = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (hit) inside = !inside;
	}
	return inside;
}

export function insideShape(
	spec: ShapeSpec,
	px: number,
	py: number,
	cx: number,
	cy: number,
	rx: number,
	ry: number,
): boolean {
	const x = px - cx;
	const y = py - cy;
	if (spec.kind === 'circle') {
		return (x / rx) ** 2 + (y / ry) ** 2 <= 1;
	}
	if (spec.kind === 'polygon' || spec.kind === 'star') {
		const poly = vertices(spec).map(([vx, vy]) => [cx + vx * rx, cy + vy * ry] as [number, number]);
		return inPolygon(px, py, poly);
	}
	return Math.abs(x) <= rx && Math.abs(y) <= ry;
}

/** Applies the equivalent CSS so the visible DOM box matches the CA substrate. */
export function applyShapeCss(el: HTMLElement, spec: ShapeSpec): void {
	if (spec.kind === 'circle') {
		el.style.borderRadius = '50%';
		return;
	}
	if (spec.kind === 'polygon' || spec.kind === 'star') {
		const pts = vertices(spec)
			.map(([vx, vy]) => `${(vx + 1) * 50}% ${(vy + 1) * 50}%`)
			.join(', ');
		el.style.clipPath = `polygon(${pts})`;
		el.style.borderRadius = '0';
		return;
	}
	el.style.clipPath = '';
	el.style.borderRadius = '';
}
