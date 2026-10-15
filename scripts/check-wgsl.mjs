// Validate the WebGPU goo shader offline with naga (crates/wgslcheck), so WGSL
// mistakes are caught without a GPU. Best-effort: if neither the built validator
// nor cargo is available it just warns and passes, so `npm run check:wgsl` never
// breaks a machine without Rust.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'crates', 'wgslcheck');
const bin = join(crate, 'target', 'release', 'wgslcheck');
const shader = join(root, 'packages', 'ca-goo', 'src', 'goo.wgsl');
const cargo = process.env.CARGO ?? 'cargo';

function have(cmd) {
	try {
		execFileSync(cmd, ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

let runner = existsSync(bin) ? bin : null;
if (!runner && have(cargo)) {
	try {
		execFileSync(cargo, ['build', '--release'], { cwd: crate, stdio: 'inherit' });
		runner = existsSync(bin) ? bin : null;
	} catch (e) {
		console.warn(`[wgsl] could not build validator: ${e.message}`);
	}
}
if (!runner) {
	console.warn('[wgsl] naga validator not built (needs Rust); skipping WGSL check.');
	process.exit(0);
}

execFileSync(runner, [shader, '--emit'], { stdio: 'inherit' });
