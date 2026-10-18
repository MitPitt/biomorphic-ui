import { GLEngine } from './engine-core';
import type { WorkerRequest, WorkerResponse } from './offscreen-protocol';
import type { MaterialRegistry, Occupancy } from './types';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface WorkerScope {
	addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
	postMessage(msg: WorkerResponse): void;
}

/**
 * Worker entry: run one `GLEngine` per transferred OffscreenCanvas. The app
 * passes the same material registry it gives `createBio`, so the worker can
 * resolve the material id each scene was measured for.
 */
export function startBioWorker(registry: MaterialRegistry): void {
	const scope = self as unknown as WorkerScope;
	const engines = new Map<string, GLEngine>();
	// One live-tissue map per bio instance, shared by every tree group in this
	// worker (all such groups are assigned to one sticky worker by the runtime).
	const occupancies = new Map<string, Occupancy>();
	const occupancyFor = (bioId: string): Occupancy => {
		let occ = occupancies.get(bioId);
		if (!occ) {
			occ = { w: 0, h: 0, owner: new Int32Array(0) };
			occupancies.set(bioId, occ);
		}
		return occ;
	};

	// Messages that arrive while an engine is being created (or retried after a
	// burst of WebGL contexts from the previous page) are queued, then replayed.
	const pending = new Map<string, WorkerRequest[]>();
	const cancelled = new Set<string>();
	let handle: (m: WorkerRequest) => void;

	const create = (m: Extract<WorkerRequest, { t: 'create' }>, attempt = 0): void => {
		if (cancelled.has(m.id)) return;
		try {
			const material = registry[m.material];
			if (!material) throw new Error(`unknown material "${m.material}"`);
			const shared = m.collideNeighbors && material.usesOccupancy;
			const engine = new GLEngine(m.canvas, material, {
				grid: m.grid,
				params: m.params,
				speed: m.speed,
				instant: m.instant,
				upsample: m.upsample,
				neighborAura: m.neighborAura,
				rand: mulberry32(m.seed),
				occupancy: shared ? occupancyFor(m.bioId) : undefined,
				token: shared ? m.token : 0,
				onStatus: (settled) => scope.postMessage({ t: 'status', id: m.id, settled }),
			});
			engines.set(m.id, engine);
			const queued = pending.get(m.id);
			if (queued) {
				pending.delete(m.id);
				for (const msg of queued) handle(msg);
			}
		} catch (err) {
			// Chrome may still be releasing the previous page's contexts; retry a
			// few times before giving up, then report the real error.
			if (attempt < 12 && !cancelled.has(m.id)) {
				setTimeout(() => create(m, attempt + 1), 250);
				return;
			}
			pending.delete(m.id);
			scope.postMessage({
				t: 'error',
				id: m.id,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	};

	handle = (m: WorkerRequest): void => {
		try {
			switch (m.t) {
				case 'hello':
					scope.postMessage({ t: 'ready', id: m.id });
					break;
				case 'create':
					cancelled.delete(m.id);
					pending.set(m.id, []);
					create(m);
					break;
				case 'dispose':
					if (!engines.has(m.id)) {
						cancelled.add(m.id);
						pending.delete(m.id);
						return;
					}
					engines.get(m.id)!.dispose();
					engines.delete(m.id);
					return;
				default: {
					if (!engines.has(m.id) && pending.has(m.id)) {
						pending.get(m.id)!.push(m);
						return;
					}
					switch (m.t) {
						case 'reset': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.speed = m.speed;
							engine.instant = m.instant;
							engine.seedChance = m.seedChance;
							engine.neighborAura = m.neighborAura;
							engine.setUpsample(m.upsample);
							engine.reset(m.scene);
							break;
						}
						case 'fit':
							engines.get(m.id)?.setGrid(m.grid);
							break;
						case 'refresh': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.refreshActivity(m.scene);
							break;
						}
						case 'wake': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.speed = m.speed;
							engine.instant = m.instant;
							engine.wake();
							break;
						}
						case 'freeze':
							engines.get(m.id)?.freeze();
							break;
						case 'unfreeze': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.instant = m.instant;
							engine.unfreeze();
							break;
						}
						case 'speed': {
							const engine = engines.get(m.id);
							if (engine) engine.speed = m.speed;
							break;
						}
						case 'playing': {
							const engine = engines.get(m.id);
							if (engine) engine.playing = m.playing;
							break;
						}
						case 'instant': {
							const engine = engines.get(m.id);
							if (engine) engine.instant = m.instant;
							break;
						}
						case 'step': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.stepOnce();
							break;
						}
						case 'settle': {
							const engine = engines.get(m.id);
							if (!engine) return;
							engine.params = { ...m.params };
							engine.instant = m.instant;
							engine.settleNow();
							break;
						}
						case 'upsample':
							engines.get(m.id)?.setUpsample(m.mode);
							break;
						case 'setMaterial': {
							const engine = engines.get(m.id);
							const material = registry[m.material];
							if (!engine || !material) return;
							engine.setMaterial(material);
							const shared = m.collideNeighbors && material.usesOccupancy;
							engine.occupancy = shared ? occupancyFor(m.bioId) : undefined;
							engine.token = shared ? m.token : 0;
							break;
						}
					}
				}
			}
		} catch (err) {
			scope.postMessage({ t: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
		}
	};

	scope.addEventListener('message', (e: MessageEvent): void => handle(e.data as WorkerRequest));
}
