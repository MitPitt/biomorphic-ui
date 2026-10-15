// @ts-check
import { defineConfig } from 'astro/config';

// point the workspace packages at their TS sources so the app builds and
// hot-reloads without a build step for the packages
const alias = (/** @type {string} */ p) => new URL(p, import.meta.url).pathname;

// https://astro.build/config
export default defineConfig({
	vite: {
		resolve: {
			alias: {
				'@biomorphic/ca-core': alias('./packages/ca-core/src/index.ts'),
				'@biomorphic/ca-flora': alias('./packages/ca-flora/src/index.ts'),
				'@biomorphic/ca-goo': alias('./packages/ca-goo/src/index.ts'),
			},
		},
	},
});
