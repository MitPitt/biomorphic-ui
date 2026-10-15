// Build the goo liquid crate (salva2d SPH) to wasm32 and place the artifact next
// to the material so Vite can bundle it. Run via `npm run wasm`.
//   Requires: rustup + `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'packages', 'ca-goo', 'crates', 'goo');
const artifact = join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'goo.wasm');
const out = join(root, 'packages', 'ca-goo', 'src', 'goo.wasm');

const cargo = process.env.CARGO ?? 'cargo';
execFileSync(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
	cwd: crate,
	stdio: 'inherit',
});

if (!existsSync(artifact)) {
	throw new Error(`build did not produce ${artifact}`);
}
copyFileSync(artifact, out);
console.log(`wrote ${out}`);
