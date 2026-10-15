// Static shader check. Catches the two ways a material's GLSL uniforms break:
//   1. a `u_*` identifier used but never declared  -> shader compile error
//   2. a declared uniform with no matching param    -> silently stays 0
// (1) fails the check (and the build); (2) only warns.
//
// Mirrors the runtime guard in @bio/ca-core glsl.ts (checkUniforms) so mistakes are
// caught before shipping. Scans every material family's src/ dir. Run via
// `npm run check` (also part of `npm run build`).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'packages', 'ca-core', 'src');
const matDirs = [
	join(root, 'packages', 'ca-flora', 'src'),
	join(root, 'packages', 'ca-goo', 'src'),
];

const BUILTIN = new Set(['u_state', 'u_state2', 'u_field', 'u_field2', 'u_frame', 'u_layer', 'u_tex']);

const strip = (s) => s.replace(/\$\{[^}]*\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

function declared(src) {
	const out = new Set();
	for (const m of strip(src).matchAll(/\buniform\s+[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/g)) out.add(m[1]);
	return out;
}
function used(src) {
	const out = new Set();
	for (const m of strip(src).matchAll(/\bu_[A-Za-z0-9_]+/g)) out.add(m[0]);
	return out;
}

const common = readFileSync(join(coreDir, 'glsl.ts'), 'utf8').match(/export const COMMON = `([\s\S]*?)`;/)[1];

let failed = false;
for (const matDir of matDirs) {
	for (const file of readdirSync(matDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
		const text = readFileSync(join(matDir, file), 'utf8');
		const keys = new Set([...text.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
		const names = [...text.matchAll(/const (\w+) = wrapFragment/g)].map((m) => m[1]);
		const bodies = [...text.matchAll(/wrapFragment\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
		bodies.forEach((body, i) => {
			const src = `#version 300 es\nprecision highp float;\n${common}\n${body}\n`;
			const dec = declared(src);
			const miss = [...used(src)].filter((u) => !dec.has(u) && !BUILTIN.has(u)).sort();
			const unset = [...dec].filter((u) => u.startsWith('u_') && !BUILTIN.has(u) && !keys.has(u.slice(2))).sort();
			const tag = `${file}:${names[i] ?? i}`;
			if (miss.length) {
				failed = true;
				console.error(`FAIL ${tag}: used but undeclared -> ${miss.join(', ')}`);
			}
			if (unset.length) console.warn(`WARN ${tag}: declared but no param (stays 0) -> ${unset.join(', ')}`);
			if (!miss.length && !unset.length) console.log(`ok   ${tag}`);
		});
	}
}

if (failed) {
	console.error('\nShader uniform check failed.');
	process.exit(1);
}
console.log('\nShader uniform check passed.');
