import { createBio } from "@biomorphic/ca-core";
import type { ActivityMode, ParamDef, UpsampleMode } from "@biomorphic/ca-core";
import { materials } from "../materials";

/**
 * Shared client bootstrap for every demo page. The page declares its material,
 * its toggle states and its re-seed counters via `data-*` attributes, and drops
 * `.sub` elements as substrate; this wires the runtime and the control panel.
 *
 *   <body data-bio-material="spikes" data-toggle-states="active,wall"
 *         data-toggle-labels="grow spikes|clear">
 */

const DEFAULT_LABEL: Record<ActivityMode, string> = {
	active: "grow",
	emitter: "emitter",
	wall: "clear",
};

export function startDemo(): void {
	const body = document.body;
	const materialId = body.dataset.bioMaterial ?? "spikes";

	const bio = createBio({
		materials,
		material: materialId,
		// shader sims + field builds + rendering run on an OffscreenCanvas worker
		worker: () => new Worker(new URL("./bio.worker.ts", import.meta.url), { type: "module" }),
	});
	document
		.querySelectorAll<HTMLElement>(".sub")
		.forEach((el) => bio.register(el));
	let engine = bio.engine()!;

	const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
	const playBtn = el<HTMLButtonElement>("play");
	const stepBtn = el<HTMLButtonElement>("step");
	const resetBtn = el<HTMLButtonElement>("reset");
	const speedEl = el<HTMLInputElement>("speed");
	const cellEl = el<HTMLInputElement>("cell");
	const budgetEl = el<HTMLInputElement>("cellbudget");
	const speedV = el("speed-v");
	const cellV = el("cell-v");
	const budgetV = el("budget-v");
	const paramsHost = el("params");

	const each = (fn: (e: ReturnType<typeof bio.engine>) => void) => {
		for (const g of bio.groups()) fn(bio.engine(g));
	};

	const paramRow = (p: ParamDef) => {
		const row = document.createElement("label");
		row.className = `ctrl ${p.kind ?? "cells"}`;
		const value = engine.params[p.key];
		row.innerHTML = `<span>${p.label} <b>${value}</b></span><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${value}">`;
		const input = row.querySelector("input") as HTMLInputElement;
		const out = row.querySelector("b") as HTMLElement;
		input.addEventListener("input", () => {
			const v = parseFloat(input.value);
			each((e) => {
				if (e) e.params[p.key] = v;
			});
			out.textContent = String(v);
			bio.wake();
		});
		if (p.reset) input.addEventListener("change", () => bio.reset());
		return row;
	};

	const buildParams = () => {
		paramsHost.innerHTML = "";
		const { params, sections } = engine.material;
		const byKey = new Map(params.map((p) => [p.key, p]));

		// demo-pinned params (e.g. a CA's fixed in/out mode) applied once
		let pinned = false;
		for (const s of sections ?? []) {
			for (const [k, v] of Object.entries(s.fixed ?? {})) {
				each((e) => {
					if (e && e.params[k] !== v) {
						e.params[k] = v;
						pinned = true;
					}
				});
			}
		}
		if (pinned) bio.reset();

		const host = (label: string, open: boolean) => {
			const det = document.createElement("details");
			det.open = open;
			const sum = document.createElement("summary");
			sum.textContent = label;
			det.appendChild(sum);
			const body = document.createElement("div");
			body.className = "group";
			det.appendChild(body);
			paramsHost.appendChild(det);
			return body;
		};

		if (!sections || sections.length === 0) {
			const body = host("rules", true);
			for (const p of params) body.appendChild(paramRow(p));
			return;
		}

		const shown = new Set<string>();
		for (const s of sections) {
			const body = host(s.label, s.open !== false);
			for (const k of s.keys) {
				const p = byKey.get(k);
				if (!p) continue;
				shown.add(k);
				body.appendChild(paramRow(p));
			}
		}
		const rest = params.filter((p) => !shown.has(p.key));
		if (rest.length > 0) {
			const body = host("other", true);
			for (const p of rest) body.appendChild(paramRow(p));
		}
	};

	// config json: the current panel state as createBio options, so a setting dialled
	// in here can be pasted into another app. The demo uses createBio's default seed.
	const configEl = document.getElementById("config") as HTMLDetailsElement | null;
	const configOut = document.getElementById("config-json") as HTMLTextAreaElement | null;
	const copyEl = document.getElementById("copy-config") as HTMLButtonElement | null;

	const configJson = () => {
		const params: Record<string, number> = {};
		for (const p of engine.material.params) {
			const v = engine.params[p.key];
			if (typeof v === "number") params[p.key] = Number(v.toFixed(4));
		}
		return JSON.stringify(
			{
				material: engine.material.id,
				seed: 0x1234abcd,
				cellBudget: engine.maxCells,
				cellSize: Number(engine.cellSize.toFixed(3)),
				speed: engine.speed,
				upsample: engine.upsampleMode,
				params,
			},
			null,
			2,
		);
	};
	configEl?.addEventListener("toggle", () => {
		if (configEl.open && configOut) configOut.value = configJson();
	});
	copyEl?.addEventListener("click", async () => {
		const text = configJson();
		if (configOut) configOut.value = text;
		try {
			await navigator.clipboard.writeText(text);
			copyEl.textContent = "copied";
		} catch {
			configOut?.focus();
			configOut?.select();
			copyEl.textContent = "select + copy";
		}
		setTimeout(() => {
			copyEl.textContent = "copy json";
		}, 1200);
	});

	const CELL_MIN = 0.1;
	const CELL_MAX = 12;
	const cellFromSlider = (v: number) =>
		CELL_MIN * Math.pow(CELL_MAX / CELL_MIN, v / 1000);
	const sliderFromCell = (c: number) =>
		(1000 * Math.log(c / CELL_MIN)) / Math.log(CELL_MAX / CELL_MIN);

	// cell budget: the per-group grid cap (masters reset/seed/field/sim cost at a fine
	// cell size). Log-scaled so the low, laggy end gets most of the slider.
	const BUDGET_MIN = 250_000;
	const BUDGET_MAX = 8_000_000;
	const budgetFromSlider = (v: number) =>
		BUDGET_MIN * Math.pow(BUDGET_MAX / BUDGET_MIN, v / 1000);
	const sliderFromBudget = (b: number) =>
		(1000 * Math.log(b / BUDGET_MIN)) / Math.log(BUDGET_MAX / BUDGET_MIN);
	const fmtBudget = (b: number) =>
		b >= 1_000_000 ? (b / 1_000_000).toFixed(2) + "M" : Math.round(b / 1000) + "k";

	speedEl.value = String(engine.speed);
	speedV.textContent = String(engine.speed);
	cellEl.value = String(Math.round(sliderFromCell(engine.cellSize)));
	cellV.textContent = engine.cellSize.toFixed(2);
	budgetEl.value = String(Math.round(sliderFromBudget(engine.maxCells)));
	budgetV.textContent = fmtBudget(engine.maxCells);
	buildParams();

	playBtn.addEventListener("click", () => {
		const playing = !engine.playing;
		each((e) => {
			if (e) e.playing = playing;
		});
		playBtn.textContent = playing ? "pause" : "play";
	});
	stepBtn.addEventListener("click", () => {
		each((e) => {
			if (e) {
				e.playing = false;
				e.stepOnce();
			}
		});
		playBtn.textContent = "play";
	});
	resetBtn.addEventListener("click", () => bio.reset());

	// instant: jump settled sims straight to their final state, no in-between steps
	const instantEl = document.getElementById("instant") as HTMLInputElement | null;
	instantEl?.addEventListener("change", () => {
		const on = instantEl.checked;
		each((e) => {
			if (!e) return;
			e.instant = on;
			if (on) e.settleNow();
		});
	});

	// freeze: hold every group's current field (no advance, no rebuild). Unfreezing
	// resumes in place, or rebuilds a group that was rigidly translated while frozen
	// so it re-adjusts to the layout.
	const freezeEl = document.getElementById("freeze") as HTMLInputElement | null;
	freezeEl?.addEventListener("change", () => {
		const on = freezeEl.checked;
		each((e) => {
			if (!e) return;
			if (on) e.freeze();
			else e.unfreeze();
		});
	});

	// condition-based redraw: `<details>` (or any element firing `toggle`) with
	// data-bio-regrow-on can force a group to rebuild when it opens/closes, so a
	// group that moved while another panel was open re-grows against the new layout
	// instead of keeping a stale rigid shape. Optional gate = a checkbox id.
	document
		.querySelectorAll<HTMLElement>("[data-bio-regrow-on]")
		.forEach((node) => {
			const when = node.dataset.bioRegrowOn ?? "close";
			const group = node.dataset.bioRegrowGroup || undefined;
			const gate = node.dataset.bioRegrowGate;
			node.addEventListener("toggle", () => {
				const open = (node as HTMLDetailsElement).open;
				if (when === "open" && !open) return;
				if (when === "close" && open) return;
				if (gate) {
					const c = document.getElementById(gate) as HTMLInputElement | null;
					if (c && !c.checked) return;
				}
				bio.reset(group);
			});
		});

	speedEl.addEventListener("input", () => {
		const v = parseInt(speedEl.value, 10);
		each((e) => {
			if (e) e.speed = v;
		});
		speedV.textContent = speedEl.value;
	});
	cellEl.addEventListener("input", () => {
		cellV.textContent = cellFromSlider(parseFloat(cellEl.value)).toFixed(2);
	});
	cellEl.addEventListener("change", () => {
		const c = cellFromSlider(parseFloat(cellEl.value));
		each((e) => {
			if (e) e.cellSize = c;
		});
		cellV.textContent = c.toFixed(2);
		bio.resize();
	});
	budgetEl.addEventListener("input", () => {
		budgetV.textContent = fmtBudget(budgetFromSlider(parseFloat(budgetEl.value)));
	});
	budgetEl.addEventListener("change", () => {
		const b = Math.round(budgetFromSlider(parseFloat(budgetEl.value)));
		each((e) => {
			if (e) e.maxCells = b;
		});
		budgetV.textContent = fmtBudget(b);
		bio.resize();
	});

	// upsample: how the resolve texture is reconstructed to the canvas (look-only)
	const upsampleEl = document.getElementById("upsample") as HTMLSelectElement | null;
	upsampleEl?.addEventListener("change", () => {
		const mode = upsampleEl.value as UpsampleMode;
		each((e) => {
			if (e) e.setUpsample(mode);
		});
	});

	// mode toggle: cycles the states declared by the page (2 for flora/tree,
	// 3 for goo). Changing an element's mode never stays a shared field.
	const toggleEl = document.getElementById("growthBtn") as HTMLElement | null;
	const states = (body.dataset.toggleStates ?? "active,wall")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean) as ActivityMode[];
	const labels = (body.dataset.toggleLabels ?? "").split("|");
	if (toggleEl && states.length > 0) {
		const text = states.map((s, i) => labels[i] ?? DEFAULT_LABEL[s]);
		const render = () => {
			const cur = (toggleEl.dataset.bioMode as ActivityMode) ?? states[0];
			const i = Math.max(0, states.indexOf(cur));
			toggleEl.textContent = text[i];
		};
		toggleEl.addEventListener("click", () => {
			const cur = (toggleEl.dataset.bioMode as ActivityMode) ?? states[0];
			const next = states[(states.indexOf(cur) + 1) % states.length];
			bio.setMode(toggleEl, next);
			render();
		});
		render();
	}

	// re-seed counters: `<b data-reseed="group">` shows how many times that group's
	// engine rebuilt, so a demo can prove a reflow touched only the group that moved.
	document.querySelectorAll<HTMLElement>("[data-reseed]").forEach((node) => {
		const group = node.dataset.reseed;
		if (!group) return;
		const e = bio.engine(group);
		if (!e) return;
		const orig = e.reset.bind(e);
		let n = 0;
		node.textContent = "0";
		e.reset = () => {
			n++;
			node.textContent = String(n);
			orig();
		};
	});
}
